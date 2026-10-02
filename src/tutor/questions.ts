import { randomInt } from "node:crypto";
import { z } from "zod";
import type { LlmClient, Source } from "../llm/index.js";

// The model writes the diagnosis questions: for each concept, one multiple-choice question
// and one open question. The open question is a short answer, or a small task for a skill.

export interface QuestionConcept {
  id: number;
  name: string;
  objective: string;
  kind: "knowledge" | "skill";
  sources: { sectionId: number; title: string; markdown: string }[];
}

export interface WrittenQuestion {
  conceptId: number;
  kind: "choice" | "short" | "apply";
  text: string;
  choices: string[] | null;
  // For a choice question, the index of the correct option. For an open question, a model answer.
  answer: string;
  // For a choice question, the explanation. For an open question, the points of a good answer.
  keyPoints: string[];
  sectionId: number | null;
}

const QuestionsSchema = z.object({
  concepts: z.array(
    z.object({
      conceptId: z.string(),
      choice: z.object({
        question: z.string(),
        options: z.array(z.string()),
        correctIndex: z.number().int(),
        explanation: z.string(),
        sectionId: z.string(),
      }),
      open: z.object({
        kind: z.enum(["short", "apply"]),
        question: z.string(),
        keyPoints: z.array(z.string()),
        modelAnswer: z.string(),
        sectionId: z.string(),
      }),
    }),
  ),
});

export const QUESTIONS_SYSTEM = `You write diagnosis questions. A diagnosis checks if a learner knows a concept already, before a lesson.
Rules:
- Base each question on the sources. Test the understanding of the concept, not the memory of the book. Do not ask about the book, the author, the chapter, page numbers, or exact words.
- The multiple-choice question has 4 options and exactly one correct option. The wrong options must look correct to a learner who does not know the concept. Do not use "all of the above" or "none of the above". The explanation tells in one or two sentences why the correct option is correct.
- The open question: for a "knowledge" concept, use kind "short": the learner explains in 1 to 3 sentences. For a "skill" concept, use kind "apply": a small task with a concrete case, for example write a query, predict a result, or choose and give the reason. The learner can answer in a few lines.
- keyPoints: 2 to 4 points that a correct answer must have. modelAnswer: a short correct answer.
- sectionId: the id of the source that the question uses.
- The two questions of a concept must test different things.`;

function questionsPrompt(concepts: QuestionConcept[]): string {
  const list = concepts.map((concept) => `c${concept.id}: ${concept.name}: ${concept.objective} [${concept.kind}]`).join("\n");
  return `Write the diagnosis questions for these concepts. Give one entry for each concept, with its conceptId (for example "c12").\n\n${list}`;
}

// Put the correct option at a random position. Models often put it first.
function shuffle(options: string[], correct: number): { options: string[]; correct: number } {
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { options: order.map((i) => options[i]!), correct: order.indexOf(correct) };
}

// The groups of concepts for the requests. A small group keeps the answer short.
export function questionBatches(concepts: QuestionConcept[], size = 4): QuestionConcept[][] {
  const batches: QuestionConcept[][] = [];
  for (let i = 0; i < concepts.length; i += size) batches.push(concepts.slice(i, i + size));
  return batches;
}

// Write the questions for a group of concepts. The function asks one more time for concepts
// with no usable questions. A concept with no usable questions after that has no questions.
export async function writeQuestions(llm: LlmClient, concepts: QuestionConcept[]): Promise<WrittenQuestion[]> {
  const result = new Map<number, WrittenQuestion[]>();
  const ask = async (group: QuestionConcept[]) => {
    const sources = new Map<number, Source>();
    // Each concept uses at most two of its sections, so that the request stays small.
    for (const concept of group) {
      for (const section of concept.sources.slice(0, 2)) {
        sources.set(section.sectionId, { id: String(section.sectionId), title: section.title, text: section.markdown });
      }
    }
    const answer = await llm.object({
      system: QUESTIONS_SYSTEM,
      sources: [...sources.values()],
      prompt: questionsPrompt(group),
      schema: QuestionsSchema,
    });
    for (const entry of answer.concepts) {
      const concept = group.find((item) => `c${item.id}` === entry.conceptId.trim());
      if (!concept || result.has(concept.id)) continue;
      const sectionOf = (id: string) => {
        const number = Number(id.replace(/\D/g, ""));
        return concept.sources.some((source) => source.sectionId === number) ? number : (concept.sources[0]?.sectionId ?? null);
      };
      const options = [...new Set(entry.choice.options.map((option) => option.trim()).filter(Boolean))];
      const choiceUsable =
        entry.choice.question.trim() !== "" && options.length >= 2 && entry.choice.correctIndex >= 0 && entry.choice.correctIndex < options.length;
      if (!choiceUsable || entry.open.question.trim() === "") continue;
      const shuffled = shuffle(options, entry.choice.correctIndex);
      result.set(concept.id, [
        {
          conceptId: concept.id,
          kind: "choice",
          text: entry.choice.question.trim(),
          choices: shuffled.options,
          answer: String(shuffled.correct),
          keyPoints: [entry.choice.explanation.trim()],
          sectionId: sectionOf(entry.choice.sectionId),
        },
        {
          conceptId: concept.id,
          kind: concept.kind === "skill" ? "apply" : entry.open.kind,
          text: entry.open.question.trim(),
          choices: null,
          answer: entry.open.modelAnswer.trim(),
          keyPoints: entry.open.keyPoints.map((point) => point.trim()).filter(Boolean),
          sectionId: sectionOf(entry.open.sectionId),
        },
      ]);
    }
  };

  await ask(concepts);
  const missing = concepts.filter((concept) => !result.has(concept.id));
  if (missing.length > 0) await ask(missing);
  return concepts.flatMap((concept) => result.get(concept.id) ?? []);
}

import { randomInt } from "node:crypto";
import { z } from "zod";
import type { LlmClient, Source } from "../llm/index.js";
import { PLAIN_MATH_RULE } from "../llm/prompt.js";

// The model writes the diagnosis questions: for each concept, one open question, and one multiple-choice question
// if the concept needs two questions. The open question is a short answer, or a small task for a skill.
// A simple concept gets only the open question, so that a guess cannot pass and the diagnosis stays short.

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
      choice: z
        .object({
          question: z.string(),
          code: z.string().nullable(),
          options: z.array(z.string()),
          correctIndex: z.number().int(),
          explanation: z.string(),
          sectionId: z.string(),
        })
        .nullable(),
      open: z.object({
        kind: z.enum(["short", "apply"]),
        question: z.string(),
        code: z.string().nullable(),
        keyPoints: z.array(z.string()),
        modelAnswer: z.string(),
        sectionId: z.string(),
      }),
    }),
  ),
});

// The learner types the answers. A short answer that shows the understanding is enough,
// so the questions do not ask for more text than the concept needs.
const SHORT_ANSWER_RULES = `- Each open question asks one thing. Do not add "explain why", "give an example", or "briefly explain" to a task.
- A choice between two or more solutions needs a reason, but a few words are enough.
- keyPoints: the 1 or 2 points that show that the learner understands the concept. Do not add a point that the question does not ask for, for example a reason, an example, or a number. modelAnswer: the shortest correct answer.`;

// The app shows plain text and inline code on one line, so code of more than one line loses its lines.
// The code of a question is in its own field, and the tutor puts it under the question as a code block.
const CODE_RULES = `- code: the code that the question shows, as plain code with its line breaks and no Markdown, or null. The question text does not repeat this code.
- In an option or an explanation, put code of more than one line in a Markdown code block with three backticks. Use inline code only for a short part of one line.`;

export const QUESTIONS_SYSTEM = `You write diagnosis questions. A diagnosis checks if a learner knows a concept already, before a lesson.
Each concept gets an open question. A simple concept gets only the open question: set choice to null. A concept with more than one part to check also gets a multiple-choice question. Most concepts are simple.
Rules:
- Base each question on the sources. Test the understanding of the concept, not the memory of the book. Do not ask about the book, the author, the chapter, page numbers, or exact words.
- The multiple-choice question has 4 options and exactly one correct option. The wrong options must look correct to a learner who does not know the concept. Do not use "all of the above" or "none of the above". The explanation tells in one or two sentences why the correct option is correct.
- The open question: for a "knowledge" concept, use kind "short": the learner explains one idea in one or two sentences. For a "skill" concept, use kind "apply": a small task with a concrete case, for example write a query, predict a result, or choose a solution. The answer is the query, the result, or the choice.
${CODE_RULES}
${SHORT_ANSWER_RULES}
- sectionId: the id of the source that the question uses.
- If a concept has two questions, they must test different things.
${PLAIN_MATH_RULE}`;

function questionsPrompt(concepts: QuestionConcept[]): string {
  const list = concepts.map((concept) => `c${concept.id}: ${concept.name}: ${concept.objective} [${concept.kind}]`).join("\n");
  return `Write the diagnosis questions for these concepts. Give one entry for each concept, with its conceptId (for example "c12").\n\n${list}`;
}

// Put the correct option at a random position. Models often put it first.
export function shuffle(options: string[], correct: number): { options: string[]; correct: number } {
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { options: order.map((i) => options[i]!), correct: order.indexOf(correct) };
}

// Code of more than one line as a Markdown code block. The app shows inline code and plain text on one line, so the
// lines of the code get lost. The model sometimes writes code in these forms, although the prompt asks for a code block.
export function codeBlocks(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/`([^`]*\n[^`]*)`/g, (_, code: string) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)))
    .join("")
    .trim();
}

// An option with more than one line is code: a sentence of an option has one line.
export function optionText(option: string): string {
  const text = codeBlocks(option.trim());
  return text.includes("\n") && !text.includes("```") ? `\`\`\`\n${text}\n\`\`\`` : text;
}

// The text of a question, with its code as a Markdown code block under it. The model sometimes puts a code block
// in the code field anyway.
export function questionText(question: string, code: string | null): string {
  const text = codeBlocks(question.trim());
  const lines = (code ?? "").replace(/^\s*\n/, "").trimEnd();
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```$/.exec(lines);
  const plain = fenced ? fenced[1]!.trimEnd() : lines;
  return text === "" || plain.trim() === "" ? text : `${text}\n\n\`\`\`\n${plain}\n\`\`\``;
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
      const openText = questionText(entry.open.question, entry.open.code);
      if (openText === "") continue;
      const questions: WrittenQuestion[] = [];
      // A choice question that is not usable asks the model again, as an empty open question does.
      if (entry.choice) {
        const text = questionText(entry.choice.question, entry.choice.code);
        const options = [...new Set(entry.choice.options.map(optionText).filter(Boolean))];
        const choiceUsable = text !== "" && options.length >= 2 && entry.choice.correctIndex >= 0 && entry.choice.correctIndex < options.length;
        if (!choiceUsable) continue;
        const shuffled = shuffle(options, entry.choice.correctIndex);
        questions.push({
          conceptId: concept.id,
          kind: "choice",
          text,
          choices: shuffled.options,
          answer: String(shuffled.correct),
          keyPoints: [codeBlocks(entry.choice.explanation.trim())],
          sectionId: sectionOf(entry.choice.sectionId),
        });
      }
      result.set(concept.id, [
        ...questions,
        {
          conceptId: concept.id,
          kind: concept.kind === "skill" ? "apply" : entry.open.kind,
          text: openText,
          choices: null,
          answer: codeBlocks(entry.open.modelAnswer.trim()),
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

// Test questions after a lesson. The model selects the questions that fit the concept:
// one question for a simple concept, and one question for each part of a larger concept.

// The most questions in one test. The learner types each answer, so a test stays short.
export const MAX_TEST_QUESTIONS = 5;

const TestQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      kind: z.enum(["recall", "explain", "apply"]),
      question: z.string(),
      // The code that the question shows, or null. The tutor puts it under the question.
      code: z.string().nullable(),
      // Only for a recall question.
      options: z.array(z.string()).nullable(),
      correctIndex: z.number().int().nullable(),
      explanation: z.string().nullable(),
      // Only for an explain or an apply question.
      keyPoints: z.array(z.string()).nullable(),
      modelAnswer: z.string().nullable(),
      sectionId: z.string(),
    }),
  ),
});

type TestItem = z.infer<typeof TestQuestionsSchema>["questions"][number];

export const TEST_QUESTIONS_SYSTEM = `You write test questions. The learner had a lesson about one concept. The test checks if the learner understands it now.
Select the questions that fit the concept, at most ${MAX_TEST_QUESTIONS}. To pass, the learner must answer each question correctly. The learner types each answer. Thus, use as few questions as the concept needs:
- A simple concept needs one question.
- A concept with more than one part can get one question for each part. Two questions must not test the same thing.
The kinds of questions:
- apply: the learner uses the concept in a concrete case, for example writes a query, predicts a result, finds an error, or chooses a solution. The answer is the query, the result, the error, or the choice. Use an apply question when the learner can use the concept in a case.
- explain: the learner explains one idea of the concept in one or two sentences. Use it for an idea that a case cannot test.
- recall: a multiple-choice question with 4 options and exactly one correct option. Use it only when the skill is to recognize something, for example a term or a rule. The wrong options must look correct to a learner who did not understand the lesson. Do not use "all of the above" or "none of the above". explanation: one or two sentences that tell why the correct option is correct.
Rules:
- At least one question is an apply or an explain question, because a guess can pass a recall question.
- For a comparison of two things, ask the learner to choose one of them for a concrete case.
- Base the questions on the sources. Do not ask about the book, the author, the chapter, page numbers, or exact words.
${CODE_RULES}
${SHORT_ANSWER_RULES}
- A recall question has options, correctIndex, and explanation, and its keyPoints and modelAnswer are null. An apply or an explain question has keyPoints and modelAnswer, and its options, correctIndex, and explanation are null.
- sectionId: the id of the source that the question uses.
- Do not repeat a question that the learner saw before. Test other parts of the concept, or the same part in a new way.
${PLAIN_MATH_RULE}`;

// One question of the model as a test question, or null if the question is not usable.
function testQuestion(conceptId: number, item: TestItem, sectionId: number | null): WrittenQuestion | null {
  const text = questionText(item.question, item.code);
  if (text === "") return null;
  if (item.kind === "recall") {
    // Find the correct option by its text, because the removal of a double option changes the positions.
    const right = item.options?.[item.correctIndex ?? -1];
    const options = [...new Set((item.options ?? []).map(optionText).filter(Boolean))];
    if (!right?.trim() || options.length < 2) return null;
    const shuffled = shuffle(options, options.indexOf(optionText(right)));
    return {
      conceptId,
      kind: "choice",
      text,
      choices: shuffled.options,
      answer: String(shuffled.correct),
      keyPoints: [codeBlocks((item.explanation ?? "").trim())],
      sectionId,
    };
  }
  return {
    conceptId,
    kind: item.kind === "explain" ? "short" : "apply",
    text,
    choices: null,
    answer: codeBlocks((item.modelAnswer ?? "").trim()),
    keyPoints: (item.keyPoints ?? []).map((point) => point.trim()).filter(Boolean),
    sectionId,
  };
}

// Write the test questions for one concept. The function asks one more time if the answer is not usable.
export async function writeTestQuestions(llm: LlmClient, concept: QuestionConcept, seen: string[]): Promise<WrittenQuestion[]> {
  const sources = concept.sources.slice(0, 3).map((section) => ({ id: String(section.sectionId), title: section.title, text: section.markdown }));
  const sectionOf = (id: string) => {
    const number = Number(id.replace(/\D/g, ""));
    return concept.sources.some((source) => source.sectionId === number) ? number : (concept.sources[0]?.sectionId ?? null);
  };
  const prompt = [
    `Write the test questions for this concept: ${concept.name}`,
    `Objective: ${concept.objective}`,
    `Kind: ${concept.kind}`,
    ...(seen.length > 0 ? ["", "The learner saw these questions before:", ...seen.slice(-10).map((text) => `- ${text}`)] : []),
  ].join("\n");

  for (let attempt = 1; attempt <= 2; attempt++) {
    const answer = await llm.object({ system: TEST_QUESTIONS_SYSTEM, sources, prompt, schema: TestQuestionsSchema });
    const questions = answer.questions
      .map((item) => testQuestion(concept.id, item, sectionOf(item.sectionId)))
      .filter((question): question is WrittenQuestion => question !== null)
      .slice(0, MAX_TEST_QUESTIONS);
    // A guess can pass a recall question. Thus, a test needs an open question.
    if (questions.some((question) => question.kind !== "choice")) return questions;
  }
  return [];
}

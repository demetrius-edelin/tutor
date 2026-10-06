import { z } from "zod";
import type { LlmClient, Source } from "../llm/index.js";

// The grader scores an answer to an open question: 2 is correct, 1 is partly correct, 0 is wrong.

const GradeSchema = z.object({
  score: z.number().int(),
  feedback: z.string(),
});

// The grade checks if the learner understands the concept, not if the answer is complete.
// The learner types the answers, so a short correct answer gets the full score.
export const GRADER_SYSTEM = `You grade the answer of a learner to one question. The grade tells if the learner understands the concept. It does not tell if the answer is complete.
- Score 2: the answer shows that the learner understands the concept, and it has no real error. A short answer, a few words, or only a query is correct. Other words with the same meaning are correct.
- Score 1: the answer has a real error, for example a wrong condition, a wrong result, or a wrong idea. Or it does not give the main point of the question.
- Score 0: the answer is wrong, or it does not answer the question.
These things do not lower the score:
- A missing explanation, reason, example, or number, if the answer shows the understanding without it. This is also true when the question asks for it.
- A key point that the answer does not state, but that a correct query or a correct result shows.
- A typo, a small syntax error, or the wrong type of quotes, if the meaning is clear.
feedback: 1 to 3 short sentences to the learner, with "you". Tell what is correct, and what is wrong. You can add a missing detail or a typo as a tip, but the tip does not change the score.`;

export interface GradeInput {
  question: string;
  keyPoints: string[];
  modelAnswer: string;
  answer: string;
  source: Source | null;
}

export interface Grade {
  score: 0 | 1 | 2;
  feedback: string;
}

export async function gradeAnswer(llm: LlmClient, input: GradeInput): Promise<Grade> {
  if (input.answer.trim() === "") return { score: 0, feedback: "You did not give an answer." };
  const result = await llm.object({
    system: GRADER_SYSTEM,
    sources: input.source ? [input.source] : [],
    prompt: `Question: ${input.question}

The key points of a good answer:
${input.keyPoints.map((point) => `- ${point}`).join("\n")}

A model answer: ${input.modelAnswer}

The answer of the learner:
${input.answer}`,
    schema: GradeSchema,
  });
  const score = Math.max(0, Math.min(2, Math.round(result.score))) as Grade["score"];
  return { score, feedback: result.feedback.trim() };
}

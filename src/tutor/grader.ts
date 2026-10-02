import { z } from "zod";
import type { LlmClient, Source } from "../llm/index.js";

// The grader scores an answer to an open question: 2 is correct, 1 is partly correct, 0 is wrong.

const GradeSchema = z.object({
  score: z.number().int(),
  feedback: z.string(),
});

export const GRADER_SYSTEM = `You grade the answer of a learner to one question.
- Score 2: the answer is correct and has the key points. Other words with the same meaning are correct.
- Score 1: the answer is partly correct, or a key point is missing.
- Score 0: the answer is wrong, or it does not answer the question.
Grade the meaning, not the words. Do not take points away for spelling or style.
feedback: 1 to 3 short sentences to the learner, with "you". Tell what is correct, and what is missing or wrong.`;

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

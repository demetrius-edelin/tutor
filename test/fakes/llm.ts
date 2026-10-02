import type { LlmClient, ObjectRequest, Source, TextRequest, TextResult } from "../../src/llm/index.js";
import { checkReferences } from "../../src/llm/references.js";

export type Stage = "extract" | "review" | "merge" | "questions" | "grade" | "lesson" | "chat";

export interface FakeCall {
  stage: Stage;
  request: ObjectRequest<unknown>;
  textRequest?: TextRequest;
}

// The concept that the fake model finds in a source: the section title, and the first words as the quote.
export function defaultConcept(source: Source) {
  return {
    name: source.title.split(" > ").at(-1)!,
    objective: `Explain ${source.title.split(" > ").at(-1)!.toLowerCase()}.`,
    kind: "knowledge" as const,
    level: "basic" as const,
    // The first words of the text, without Markdown characters. The words stay exact.
    quote: source.text.replace(/[#*_`>|\\[\]]/g, " ").split(/\s+/).filter(Boolean).slice(0, 5).join(" "),
  };
}

export interface FakeHandlers {
  extract?: (sources: Source[], call: number) => unknown;
  review?: (sources: Source[], prompt: string) => unknown;
  merge?: (ids: string[], prompt: string) => unknown;
  questions?: (conceptIds: string[], sources: Source[]) => unknown;
  grade?: (prompt: string) => unknown;
  text?: (request: TextRequest) => TextResult;
}

// Default questions: the first option is correct, and a good open answer contains "point".
export function defaultQuestions(conceptIds: string[], sources: Source[]) {
  return {
    concepts: conceptIds.map((conceptId) => ({
      conceptId,
      choice: {
        question: `Which option is right for ${conceptId}?`,
        options: ["right", "wrong one", "wrong two", "wrong three"],
        correctIndex: 0,
        explanation: "The first option is right.",
        sectionId: sources[0]?.id ?? "0",
      },
      open: {
        kind: "short",
        question: `Explain ${conceptId}.`,
        keyPoints: ["point"],
        modelAnswer: "The point.",
        sectionId: sources[0]?.id ?? "0",
      },
    })),
  };
}

// A model for the tests. It answers each stage with JSON that the handlers make from the request.
export class FakeLlm implements LlmClient {
  readonly calls: FakeCall[] = [];

  constructor(private readonly handlers: FakeHandlers = {}) {}

  count(stage: Stage): number {
    return this.calls.filter((call) => call.stage === stage).length;
  }

  async object<T>(request: ObjectRequest<T>): Promise<T> {
    const stage: Stage = request.system.startsWith("You read sections")
      ? "extract"
      : request.system.startsWith("You check the list")
        ? "review"
        : request.system.startsWith("You write diagnosis questions")
          ? "questions"
          : request.system.startsWith("You grade the answer")
            ? "grade"
            : "merge";
    this.calls.push({ stage, request: request as ObjectRequest<unknown> });
    const sources = request.sources ?? [];
    let answer: unknown;
    if (stage === "extract") {
      answer = this.handlers.extract?.(sources, this.count("extract")) ?? {
        sections: sources.map((source) => ({ sectionId: source.id, concepts: [defaultConcept(source)], noConceptReason: null })),
      };
    } else if (stage === "review") {
      answer = this.handlers.review?.(sources, request.prompt) ?? { items: [], newConcepts: [] };
    } else if (stage === "questions") {
      const ids = [...request.prompt.matchAll(/^(c\d+): /gm)].map((match) => match[1]!);
      answer = this.handlers.questions?.(ids, sources) ?? defaultQuestions(ids, sources);
    } else if (stage === "grade") {
      const learner = request.prompt.split("The answer of the learner:\n")[1] ?? "";
      answer = this.handlers.grade?.(request.prompt) ?? {
        score: learner.includes("point") ? 2 : 0,
        feedback: learner.includes("point") ? "You have the point." : "You miss the point.",
      };
    } else {
      const ids = [...request.prompt.matchAll(/^(n\d+): /gm)].map((match) => match[1]!);
      answer = this.handlers.merge?.(ids, request.prompt) ?? {
        newModules: ["Basics"],
        concepts: ids.map((id, i) => ({
          id,
          action: "add",
          joinWith: null,
          module: "Basics",
          level: "basic",
          prerequisites: i > 0 ? [ids[0]!] : [],
        })),
      };
    }
    return request.schema.parse(answer);
  }

  async text(request: TextRequest): Promise<TextResult> {
    const stage: Stage = request.system.startsWith("You are a tutor. You teach") ? "lesson" : "chat";
    this.calls.push({ stage, request: { system: request.system, prompt: "", schema: null as never }, textRequest: request });
    if (this.handlers.text) return this.handlers.text(request);
    // One reference to the first words of the first source. The check keeps it, because the quote is in the source.
    const source = request.sources[0];
    const quote = source ? defaultConcept(source).quote : "";
    const text = stage === "lesson" ? `## Explanation\n\nThe concept, from the book [1].` : `The answer to your question [1].`;
    return checkReferences(text, source ? [{ number: 1, sourceId: source.id, quote }] : [], request.sources);
  }
}

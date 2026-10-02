import type { LlmClient, ObjectRequest, Source, TextRequest, TextResult } from "../../src/llm/index.js";

export type Stage = "extract" | "review" | "merge";

export interface FakeCall {
  stage: Stage;
  request: ObjectRequest<unknown>;
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

  async text(_request: TextRequest): Promise<TextResult> {
    return { text: "", references: [] };
  }
}

import type { Source } from "./types.js";
import { escapeHtml } from "../ingest/core/text.js";

// Put the sources in the prompt. Each source has an id that the model can use.
export function formatSources(sources: Source[], ids: string[] = sources.map((source) => source.id)): string {
  return sources
    .map((source, i) => `<source id="${escapeHtml(ids[i]!)}" title="${escapeHtml(source.title)}">\n${source.text}\n</source>`)
    .join("\n\n");
}

export const REFERENCE_INSTRUCTIONS = `Base your answer on the sources. After each statement that uses a source, add a reference in this form: [S2: "exact quote"]. S2 is the id of the source. The quote is a short passage that you copy exactly from the source, with no change. Do not add a list of references at the end.`;

// The rule for the prompts that write text for the app. The app shows Markdown with no math, so the learner sees
// LaTeX as raw text, for example "(a \times b)". The app also changes LaTeX to plain text (src/app/math.ts).
export const PLAIN_MATH_RULE = "- Write formulas as plain text with Unicode symbols, for example 2 × 5, x², √x, (a + b)/c, and ≤. Do not use LaTeX.";

export function jsonInstructions(schema: object): string {
  return `Answer with one JSON value and no other text. The JSON must match this JSON schema:\n${JSON.stringify(schema)}`;
}

// Read a JSON value from model text. The text can have a Markdown code fence around the JSON.
export function readJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced ? fenced[1]! : text).trim());
}

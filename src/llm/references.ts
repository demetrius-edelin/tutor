import type { Reference, Source } from "./types.js";

// Compare quotes without differences in space, case, or quote characters.
function normalize(text: string): string {
  return text
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Collect references. Two references with the same source and quote get one number.
export class ReferenceList {
  private readonly items: Reference[] = [];

  add(sourceId: string, quote: string): number {
    const key = normalize(quote);
    const found = this.items.find((item) => item.sourceId === sourceId && normalize(item.quote) === key);
    if (found) return found.number;
    const number = this.items.length + 1;
    this.items.push({ number, sourceId, quote: quote.trim() });
    return number;
  }

  list(): Reference[] {
    return [...this.items];
  }
}

// Keep only the references with a quote that is in the text of the source.
// Remove the markers of the other references, and number the markers again from 1.
export function checkReferences(text: string, references: Reference[], sources: Source[]): { text: string; references: Reference[] } {
  const sourceText = new Map(sources.map((source) => [source.id, normalize(source.text)]));
  const renumber = new Map<number, number>();
  const kept: Reference[] = [];
  for (const reference of references) {
    const quote = normalize(reference.quote);
    if (!quote || !sourceText.get(reference.sourceId)?.includes(quote)) continue;
    renumber.set(reference.number, kept.length + 1);
    kept.push({ ...reference, number: kept.length + 1 });
  }
  const cleaned = text
    .replace(/ ?\[(\d+)\]/g, (marker, number: string) => {
      const next = renumber.get(Number(number));
      return next === undefined ? "" : ` [${next}]`;
    })
    .replace(/ (\[\d+\])(?: \1)+/g, " $1");
  return { text: cleaned, references: kept };
}

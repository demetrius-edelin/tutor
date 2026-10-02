import type { Reference, Source } from "./types.js";

// Remove Markdown formatting, so that a plain quote matches the Markdown text of a section.
// For example, "compared to **UNION**" and "column\\_name" become "compared to UNION" and "column_name".
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\\?[.)])\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/`+/g, "")
    .replace(/(^|[\s([])[*_]+(?=\S)/g, "$1")
    .replace(/(\S)[*_]+(?=$|[\s).,;:!?\]])/g, "$1")
    .replace(/\|/g, " ");
}

// Compare quotes without differences in Markdown formatting, space, case, or quote characters.
export function normalizeQuote(text: string): string {
  return stripMarkdown(text)
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
    const key = normalizeQuote(quote);
    const found = this.items.find((item) => item.sourceId === sourceId && normalizeQuote(item.quote) === key);
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
  const sourceText = new Map(sources.map((source) => [source.id, normalizeQuote(source.text)]));
  const renumber = new Map<number, number>();
  const kept: Reference[] = [];
  for (const reference of references) {
    const quote = normalizeQuote(reference.quote);
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

// True if the quote is in the text, without differences in Markdown formatting, space, case,
// or quote characters. A quote that the model shortened with "..." matches if each part is in the text.
export function containsQuote(text: string, quote: string): boolean {
  const haystack = normalizeQuote(text);
  const parts = quote
    .split(/\.{3}|…/)
    .map(normalizeQuote)
    .filter((part) => part.length > 0);
  return parts.length > 0 && parts.every((part) => haystack.includes(part));
}

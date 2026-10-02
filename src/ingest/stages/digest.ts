import { createHash } from "node:crypto";
import type { ChecklistItem } from "../core/types.js";
import type { LlmClient } from "../../llm/index.js";
import { containsQuote, normalizeQuote } from "../../llm/references.js";
import { extractGroup, groupSections } from "./extract.js";
import { reviewGroup } from "./review.js";
import type { ChapterDigest, ChapterInput, FoundConcept, ModelConcept } from "./types.js";

// A key of the chapter content. The cache of a chapter digest is valid only for the same key.
export function chapterKey(chapter: ChapterInput): string {
  const content = chapter.sections.map((section) => `${section.id}:${section.words}:${section.title}`).join("|");
  return createHash("sha1").update(`${chapter.number}|${chapter.title}|${content}`).digest("hex");
}

// The number of model requests for a chapter, without the second requests: one extract
// request and one review request for each group of sections.
export function requestsFor(chapter: ChapterInput): number {
  return groupSections(chapter.sections).length * 2;
}

// Run the extract and review stages for one chapter.
export async function digestChapter(
  llm: LlmClient,
  bookTitle: string,
  chapter: ChapterInput,
  checklist: ChecklistItem[],
  log: (line: string) => void = () => {},
): Promise<ChapterDigest> {
  const sections = new Map(chapter.sections.map((section) => [section.id, section]));
  const concepts = new Map<string, FoundConcept>();
  const emptySections = new Map<string, string>();
  const missingSections: string[] = [];
  const minorItems: ChapterDigest["minorItems"] = [];
  let skippedItems = 0;

  // Two sections can give the same concept. Then the concept gets both sections as sources.
  const add = (concept: ModelConcept, sectionId: string, origin: FoundConcept["origin"]) => {
    const section = sections.get(sectionId);
    if (!section) return;
    emptySections.delete(sectionId);
    const source = { sectionId, quote: concept.quote.trim(), quoteFound: containsQuote(section.markdown, concept.quote) };
    const key = normalizeQuote(concept.name);
    const existing = concepts.get(key);
    if (existing) {
      if (!existing.sources.some((other) => other.sectionId === sectionId)) existing.sources.push(source);
      return;
    }
    concepts.set(key, {
      name: concept.name.trim(),
      objective: concept.objective.trim(),
      kind: concept.kind,
      level: concept.level,
      sources: [source],
      origin,
    });
  };

  const groups = groupSections(chapter.sections);
  for (const [i, group] of groups.entries()) {
    log(`  sections ${group[0]!.id} to ${group.at(-1)!.id} (${i + 1} of ${groups.length})`);
    const entries = await extractGroup(llm, bookTitle, chapter, group);
    for (const section of group) {
      const entry = entries.get(section.id);
      if (!entry) missingSections.push(section.id);
      else if (entry.concepts.length === 0) emptySections.set(section.id, entry.reason ?? "no reason given");
      else for (const concept of entry.concepts) add(concept, section.id, "extract");
    }

    const ids = new Set(group.map((section) => section.id));
    const groupConcepts = [...concepts.values()].filter((concept) => concept.sources.some((source) => ids.has(source.sectionId)));
    const items = checklist.filter((item) => item.sectionId !== null && ids.has(item.sectionId));
    const review = await reviewGroup(llm, bookTitle, chapter, group, groupConcepts, items);
    for (const concept of review.newConcepts) add(concept, concept.sectionId, "review");
    minorItems.push(...review.minorItems);
    skippedItems += review.skippedItems;
  }

  const found = [...concepts.values()];
  return {
    chapter: chapter.number,
    key: chapterKey(chapter),
    concepts: found,
    emptySections: [...emptySections].map(([sectionId, reason]) => ({ sectionId, reason })),
    missingSections: missingSections.filter((id) => !found.some((concept) => concept.sources.some((source) => source.sectionId === id))),
    minorItems,
    quoteWarnings: found.flatMap((concept) =>
      concept.sources
        .filter((source) => !source.quoteFound)
        .map((source) => ({ concept: concept.name, sectionId: source.sectionId, quote: source.quote })),
    ),
    skippedItems,
  };
}

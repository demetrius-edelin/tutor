import { z } from "zod";
import type { ChecklistItem } from "../core/types.js";
import type { LlmClient } from "../../llm/index.js";
import { normalizeQuote } from "../../llm/references.js";
import { CONCEPT_RULES, toSource } from "./extract.js";
import { ConceptSchema, type ChapterInput, type FoundConcept, type ModelConcept, type SectionInput } from "./types.js";

// Stage 3 of ingest: a second look at each group of sections. The model checks the
// items that the author marks as important, and finds ideas that the first look missed.

const ReviewSchema = z.object({
  items: z.array(
    z.object({
      term: z.string(),
      decision: z.enum(["existing", "new", "minor"]),
      concept: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  newConcepts: z.array(ConceptSchema.extend({ sectionId: z.string() })),
});

const REVIEW_SYSTEM = `You check the list of concepts of some book sections, so that the list misses no important idea.
${CONCEPT_RULES}
If you are not sure that an idea is a concept, add it. The learner can skip it later.`;

// The maximum number of checklist items in one request.
export const MAX_ITEMS = 60;

// True if a checklist item matches a concept: the term is in the name, the objective, or a quote.
export function itemMatches(item: ChecklistItem, concept: FoundConcept): boolean {
  const term = normalizeQuote(item.term.replace(/ \(.*\)$/, ""));
  if (!term) return true;
  const texts = [concept.name, concept.objective, ...concept.sources.map((source) => source.quote)];
  return texts.some((text) => normalizeQuote(text).includes(term)) || term.includes(normalizeQuote(concept.name));
}

function describeItem(item: ChecklistItem): string {
  const detail = item.detail ? ` (definition: ${item.detail})` : "";
  return `- ${item.term} [${item.source}, section ${item.sectionId ?? "?"}]${detail}`;
}

function reviewPrompt(bookTitle: string, chapter: ChapterInput, concepts: FoundConcept[], items: ChecklistItem[]): string {
  const list = concepts.length > 0 ? concepts.map((concept) => `- ${concept.name}: ${concept.objective}`).join("\n") : "(no concepts)";
  const checklist = items.length > 0 ? items.map(describeItem).join("\n") : "(no items)";
  return `Book: ${bookTitle}
Chapter ${chapter.number}: ${chapter.title}

These concepts were found in the sections:
${list}

The author marks these items as important, but they match no concept in the list:
${checklist}

Do two tasks:
1. For each item, give one decision:
   - "existing": a concept in the list covers the item. Give the name of that concept in "concept".
   - "new": the item is a concept that the list does not have. Add it to newConcepts, and give its name in "concept".
   - "minor": the item is not a concept, for example an example, a name, or a word with no idea behind it. Give a short reason.
2. Read the sections again. Find other important ideas that the list does not have. Add each one to newConcepts.
For each new concept, give the sectionId of the section that teaches it.`;
}

export interface ReviewResult {
  newConcepts: (ModelConcept & { sectionId: string })[];
  minorItems: { term: string; source: string; reason: string }[];
  skippedItems: number;
}

const SOURCE_ORDER: ChecklistItem["source"][] = ["summary", "glossary", "index", "dfn", "bold", "emphasis"];

export async function reviewGroup(
  llm: LlmClient,
  bookTitle: string,
  chapter: ChapterInput,
  sections: SectionInput[],
  concepts: FoundConcept[],
  checklist: ChecklistItem[],
): Promise<ReviewResult> {
  const unmatched = checklist
    .filter((item) => !concepts.some((concept) => itemMatches(item, concept)))
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  const items = unmatched.slice(0, MAX_ITEMS);

  const result = await llm.object({
    system: REVIEW_SYSTEM,
    sources: sections.map((section) => toSource(chapter, section)),
    prompt: reviewPrompt(bookTitle, chapter, concepts, items),
    schema: ReviewSchema,
  });

  const ids = new Set(sections.map((section) => section.id));
  const sourceOf = new Map(items.map((item) => [normalizeQuote(item.term), item.source]));
  return {
    newConcepts: result.newConcepts.filter((concept) => ids.has(concept.sectionId)),
    minorItems: result.items
      .filter((item) => item.decision === "minor")
      .map((item) => ({
        term: item.term,
        source: sourceOf.get(normalizeQuote(item.term)) ?? "unknown",
        reason: item.reason ?? "",
      })),
    skippedItems: unmatched.length - items.length,
  };
}

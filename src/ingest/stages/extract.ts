import { z } from "zod";
import type { LlmClient, Source } from "../../llm/index.js";
import { containsQuote } from "../../llm/references.js";
import { ConceptSchema, type ChapterInput, type ModelConcept, type SectionInput } from "./types.js";

// Stage 2 of ingest: the model finds the concepts of each section.

const ExtractSchema = z.object({
  sections: z.array(
    z.object({
      sectionId: z.string(),
      concepts: z.array(ConceptSchema),
      noConceptReason: z.string().nullable(),
    }),
  ),
});

export const CONCEPT_RULES = `A concept is one idea that a tutor can teach in 5 to 10 minutes and test with 3 questions. A full topic is too large. One small fact is too small.
For each concept, give these fields:
- name: 2 to 6 words. The name must be clear without the book.
- objective: one sentence. It tells what the learner can explain or do after learning the concept.
- kind: "skill" if the learner must do something, for example write, run, configure, or calculate. Otherwise "knowledge".
- level: "basic", "intermediate", or "advanced", for the subject of the book.
- quote: 5 to 25 words that you copy exactly from the section that teaches the concept. Do not change the words.`;

export const EXTRACT_SYSTEM = `You read sections of a book and find the concepts that a learner must know.
${CONCEPT_RULES}
If you are not sure that an idea is a concept, keep it. The learner can skip it later. A missed concept cannot be found later.
Do not add a concept that the sections do not teach.`;

function extractPrompt(bookTitle: string, chapter: ChapterInput, sections: SectionInput[]): string {
  return `Book: ${bookTitle}
Chapter ${chapter.number}: ${chapter.title}

Find the concepts in these sections: ${sections.map((section) => section.id).join(", ")}.
Give one entry for each section, in the same order, with its sectionId.
If a section teaches no new concept, give an empty list and a short reason in noConceptReason, for example "introduction", "summary", "exercises", or "example of an earlier concept". Otherwise noConceptReason is null.
A concept that two sections teach goes in the entry of the section that teaches it best.`;
}

export function toSource(chapter: ChapterInput, section: SectionInput): Source {
  return { id: section.id, title: `${chapter.title} > ${section.title}`, text: section.markdown };
}

// Put the sections of a chapter into groups for the model requests. A group has a maximum
// number of sections and a maximum size, so that the answer stays short and the request stays small.
export function groupSections(sections: SectionInput[], maxSections = 8, maxTokens = 24000): SectionInput[][] {
  const tokens = (section: SectionInput) => Math.ceil(section.words * 1.4);
  const groups: SectionInput[][] = [];
  let size = 0;
  for (const section of sections) {
    const last = groups.at(-1);
    if (!last || last.length >= maxSections || (size > 0 && size + tokens(section) > maxTokens)) {
      groups.push([section]);
      size = tokens(section);
    } else {
      last.push(section);
      size += tokens(section);
    }
  }
  return groups;
}

export interface SectionEntry {
  concepts: ModelConcept[];
  reason: string | null;
}

const badQuotes = (section: SectionInput, entry: SectionEntry | undefined) =>
  entry ? entry.concepts.filter((concept) => !containsQuote(section.markdown, concept.quote)).length : Infinity;

// Find the concepts of one group of sections. The function asks the model one more time
// for the sections without an entry, and for the sections with a quote that is not in the text.
export async function extractGroup(
  llm: LlmClient,
  bookTitle: string,
  chapter: ChapterInput,
  sections: SectionInput[],
): Promise<Map<string, SectionEntry>> {
  const ask = async (group: SectionInput[]) => {
    const result = await llm.object({
      system: EXTRACT_SYSTEM,
      sources: group.map((section) => toSource(chapter, section)),
      prompt: extractPrompt(bookTitle, chapter, group),
      schema: ExtractSchema,
    });
    const ids = new Set(group.map((section) => section.id));
    const entries = new Map<string, SectionEntry>();
    for (const entry of result.sections) {
      if (ids.has(entry.sectionId) && !entries.has(entry.sectionId)) {
        entries.set(entry.sectionId, { concepts: entry.concepts, reason: entry.noConceptReason });
      }
    }
    return entries;
  };

  const entries = await ask(sections);
  const retry = sections.filter((section) => badQuotes(section, entries.get(section.id)) > 0);
  if (retry.length > 0) {
    const second = await ask(retry);
    for (const section of retry) {
      const entry = second.get(section.id);
      if (entry && badQuotes(section, entry) < badQuotes(section, entries.get(section.id))) entries.set(section.id, entry);
    }
  }
  return entries;
}

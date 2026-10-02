import { z } from "zod";

export const KINDS = ["knowledge", "skill"] as const;
export const LEVELS = ["basic", "intermediate", "advanced"] as const;
export type Kind = (typeof KINDS)[number];
export type Level = (typeof LEVELS)[number];

// The concept fields that the model writes.
export const ConceptSchema = z.object({
  name: z.string(),
  objective: z.string(),
  kind: z.enum(KINDS),
  level: z.enum(LEVELS),
  quote: z.string(),
});
export type ModelConcept = z.infer<typeof ConceptSchema>;

// A section of the book, as the stages see it.
export interface SectionInput {
  id: string;
  title: string;
  markdown: string;
  words: number;
}

export interface ChapterInput {
  number: number;
  title: string;
  sections: SectionInput[];
}

export interface ConceptSource {
  sectionId: string;
  quote: string;
  // False if the quote is not in the text of the section.
  quoteFound: boolean;
}

// A concept that the extract or review stage found in one chapter.
export interface FoundConcept {
  name: string;
  objective: string;
  kind: Kind;
  level: Level;
  sources: ConceptSource[];
  origin: "extract" | "review";
}

// The result of the extract and review stages for one chapter.
export interface ChapterDigest {
  chapter: number;
  // A key of the chapter sections. A cached digest with another key is out of date.
  key: string;
  concepts: FoundConcept[];
  emptySections: { sectionId: string; reason: string }[];
  // Sections without an entry from the model, also after the second request.
  missingSections: string[];
  minorItems: { term: string; source: string; reason: string }[];
  quoteWarnings: { concept: string; sectionId: string; quote: string }[];
  // Checklist items that the review stage did not get, because the list was too long.
  skippedItems: number;
}

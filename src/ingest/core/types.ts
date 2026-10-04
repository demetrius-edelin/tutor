import type { BookImage } from "./source.js";

export type ChapterKind = "chapter" | "appendix" | "glossary" | "index" | "front" | "back" | "part";

export type ChecklistSource = "summary" | "glossary" | "index" | "dfn" | "bold" | "emphasis";

export interface ChecklistItem {
  term: string;
  source: ChecklistSource;
  sectionId: string | null;
  // For a glossary item, the definition.
  detail?: string;
}

export interface ParsedSection {
  // "<chapter>.<section>", for example "3.2".
  id: string;
  number: number;
  title: string;
  page: string | null;
  markdown: string;
  // The words in the Markdown text and in the source XHTML text.
  words: number;
  sourceWords: number;
  // The ids of the images in the section that the model can read, in order.
  images: string[];
}

export interface ParsedChapter {
  number: number;
  title: string;
  kind: "chapter" | "appendix";
  part: string | null;
  files: string[];
  words: number;
  sourceWords: number;
  sections: ParsedSection[];
  checklist: ChecklistItem[];
}

// A part of the book that ingest does not teach.
export interface SkippedPart {
  title: string;
  kind: ChapterKind;
  words: number;
  files: string[];
}

export type WarningCode =
  | "no_toc"
  | "toc_target_missing"
  | "toc_order"
  | "not_in_toc"
  | "lost_text"
  | "empty_section"
  | "size_split"
  | "skipped_text"
  | "unassigned_terms"
  | "unread_images"
  | "reader_note";

export interface ParseWarning {
  code: WarningCode;
  message: string;
  chapter?: number;
}

export interface ParsedBook {
  format: "epub" | "pdf";
  title: string;
  authors: string[];
  tocSource: "nav" | "ncx" | "outline" | "none";
  chapters: ParsedChapter[];
  skipped: SkippedPart[];
  glossaryEntries: number;
  indexEntries: number;
  // Glossary and index terms that the parser did not find in the text of a chapter.
  unassignedTerms: ChecklistItem[];
  warnings: ParseWarning[];
  // The images that the model can read, by id.
  images: Map<string, BookImage>;
}

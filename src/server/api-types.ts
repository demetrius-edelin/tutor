// The types of the HTTP API. The server and the browser app both use them.

export const STATUSES = ["new", "to_test", "known", "failed", "queued", "learning", "mastered", "skipped"] as const;
export type Status = (typeof STATUSES)[number];

export type StatusCounts = Record<Status, number>;

export interface ThemeSummary {
  slug: string;
  name: string;
  books: number;
  modules: number;
  concepts: number;
  progress: StatusCounts;
}

export interface BookSummary {
  slug: string;
  title: string;
  format: "epub" | "pdf";
  chapters: number;
  // The chapters with at least one concept. It is smaller than chapters after a partial ingest.
  chaptersWithConcepts: number;
  sections: number;
  words: number;
  // The concepts with at least one source in this book.
  concepts: number;
}

export interface ThemeDetail extends ThemeSummary {
  bookList: BookSummary[];
}

export interface SourceRef {
  sectionId: number;
  // The section number in the book, for example "2.3".
  ref: string;
  book: string;
  title: string;
  page: string | null;
  quote: string;
}

export interface ConceptView {
  id: number;
  slug: string;
  name: string;
  objective: string;
  kind: "knowledge" | "skill";
  level: "basic" | "intermediate" | "advanced";
  status: Status;
  prerequisites: { slug: string; name: string }[];
  sources: SourceRef[];
}

export interface ModuleView {
  id: number;
  position: number;
  name: string;
  concepts: ConceptView[];
}

export interface ConceptMapView {
  theme: { slug: string; name: string };
  modules: ModuleView[];
}

export interface SectionView {
  id: number;
  book: string;
  chapterTitle: string;
  ref: string;
  title: string;
  page: string | null;
  markdown: string;
}

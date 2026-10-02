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
  nextModule: NextModule | null;
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

// A theme also suggests the next module to diagnose: the first module in the map order
// that has concepts that the learner did not mark yet.
export interface NextModule {
  id: number;
  position: number;
  name: string;
  newConcepts: number;
}

// Diagnosis

// "later" sets the concept back to "not started", so that the learner can decide later.
export type Mark = "test" | "learn" | "skip" | "later";
export type Choice = "learn" | "skip" | "keep";

export interface SelectionResult {
  // The session of the diagnosis, or null if no concept has the mark "test".
  sessionId: number | null;
  queued: number;
  skipped: number;
}

export interface AttemptView {
  id: number;
  answer: string;
  score: number;
  correct: boolean;
  disputed: boolean;
  feedback: string;
  // For a choice question: the index of the correct option. For an open question: null.
  correctIndex: number | null;
  // For a choice question: the explanation. For an open question: the points of a good answer.
  keyPoints: string[];
  // For an open question: a model answer.
  modelAnswer: string | null;
}

export interface QuestionView {
  id: number;
  conceptId: number;
  conceptName: string;
  kind: "choice" | "short" | "apply";
  text: string;
  choices: string[] | null;
  source: { sectionId: number; ref: string; title: string; page: string | null } | null;
  attempt: AttemptView | null;
}

export interface ConceptResult {
  conceptId: number;
  slug: string;
  name: string;
  // "none" for a concept that got no usable questions.
  result: "known" | "failed" | "none";
  status: Status;
  wrong: { question: string; answer: string; feedback: string }[];
}

export interface SessionView {
  id: number;
  theme: { slug: string; name: string };
  module: { id: number; position: number; name: string } | null;
  kind: "diagnose" | "test" | "review";
  status: "preparing" | "ready" | "finished" | "failed";
  error: string | null;
  // Concepts with questions, and all concepts of the session.
  prepared: number;
  total: number;
  questions: QuestionView[];
  results: ConceptResult[] | null;
}

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
  moduleList: ModuleSummary[];
  // The first concept of the study queue, or null if the queue is empty.
  nextToLearn: { conceptId: number; name: string; objective: string; status: Status; module: { position: number; name: string } } | null;
}

// A module of a theme, with the number of its concepts in each status.
export interface ModuleSummary {
  id: number;
  position: number;
  name: string;
  concepts: number;
  progress: StatusCounts;
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
  // True for an important concept that the user starred.
  starred: boolean;
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
  kind: "diagnose" | "test";
  status: "preparing" | "ready" | "finished" | "failed";
  error: string | null;
  // Concepts with questions, and all concepts of the session.
  prepared: number;
  total: number;
  questions: QuestionView[];
  results: ConceptResult[] | null;
  // For a test after a lesson: the concept, and the outcome after the end of the test.
  concept: { id: number; slug: string; name: string } | null;
  outcome: TestOutcome | null;
}

// Study queue

export interface QueuePrerequisite {
  conceptId: number;
  slug: string;
  name: string;
  status: Status;
  // The module of the prerequisite. It can be a different module from the module of the concept.
  module: { position: number; name: string };
  // The place of the prerequisite in the queue, or null if it is not in the queue.
  position: number | null;
}

// A problem with the prerequisites of a concept in the queue.
// "later": the prerequisites come later in the queue.
// "missing": the prerequisites are not in the queue, and the learner does not know them.
export interface QueueWarning {
  kind: "later" | "missing";
  prerequisites: QueuePrerequisite[];
}

export interface QueueItem {
  conceptId: number;
  slug: string;
  name: string;
  objective: string;
  kind: "knowledge" | "skill";
  level: "basic" | "intermediate" | "advanced";
  module: { id: number; position: number; name: string };
  status: "queued" | "learning";
  position: number;
  // The book sections that teach the concept.
  sources: SourceInfo[];
  prerequisites: QueuePrerequisite[];
  // A problem with the prerequisites, or null if there is no problem.
  warning: QueueWarning | null;
}

export interface QueueView {
  theme: { slug: string; name: string };
  items: QueueItem[];
  // True if the suggested order of the tutor is different from the current order.
  suggestionDiffers: boolean;
  // True if the order of the sections in the books is different from the current order.
  bookOrderDiffers: boolean;
  // The concepts of the theme that the learner did not choose yet, and the number of their modules.
  notChosen: { concepts: number; modules: number };
}

// Lessons

export interface SourceInfo {
  sectionId: number;
  ref: string;
  title: string;
  book: string;
  page: string | null;
}

export interface LessonReference extends SourceInfo {
  number: number;
  quote: string;
}

export interface LessonMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  references: LessonReference[];
}

export interface LessonView {
  concept: {
    id: number;
    slug: string;
    name: string;
    objective: string;
    kind: "knowledge" | "skill";
    level: "basic" | "intermediate" | "advanced";
    status: Status;
    starred: boolean;
    theme: { slug: string; name: string };
    module: { id: number; position: number; name: string };
  };
  // The latest lesson about the concept, or null if the tutor did not teach it yet.
  lesson: {
    id: number;
    round: number;
    text: string;
    references: LessonReference[];
    createdAt: string;
  } | null;
  messages: LessonMessage[];
  sources: SourceInfo[];
  // The prerequisites that the learner does not know yet, and a warning about them.
  missingPrerequisites: { conceptId: number; slug: string; name: string; status: Status; position: number | null }[];
  warning: string | null;
  queuePosition: number | null;
  // The first concept in the study queue after this concept, or null.
  next: { conceptId: number; name: string } | null;
  // A test after the lesson that the learner did not finish, or null.
  openTestId: number | null;
  failedTests: number;
}

// The test after a lesson

export interface TestOutcome {
  passed: boolean;
  correct: number;
  total: number;
  applyCorrect: boolean;
  // The finished tests of the concept that the learner failed, this test included.
  failedTests: number;
  hasPrerequisites: boolean;
  // After a pass: the next concept in the study queue, or null.
  next: { conceptId: number; name: string } | null;
}

export type AfterTestAction = "later" | "skip";

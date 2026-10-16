// The types of the HTTP API. The server and the browser app both use them.

export const STATUSES = ["new", "to_test", "known", "failed", "queued", "learning", "mastered", "skipped"] as const;
export type Status = (typeof STATUSES)[number];

export type StatusCounts = Record<Status, number>;

export interface SubjectSummary {
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

// A diagnosis that did not finish. The answers stay, so the learner can continue it.
export interface OpenDiagnosis {
  sessionId: number;
  status: "preparing" | "ready" | "failed";
  // The concepts that wait for their test, the questions, and the questions with an answer.
  concepts: number;
  questions: number;
  answered: number;
}

export interface SubjectDetail extends SubjectSummary {
  bookList: BookSummary[];
  moduleList: ModuleSummary[];
  // The first concept of the study queue, or null if the queue is empty.
  nextToLearn: { conceptId: number; name: string; objective: string; status: Status; module: { position: number; name: string } } | null;
  // The ingest run in progress in the subject, or null.
  ingest: IngestView | null;
  // The books with a run in the app that the subject did not save, for example after a preview.
  unsavedBooks: { slug: string; title: string }[];
  openDiagnoses: OpenDiagnosis[];
}

// Ingest in the app

export type IngestMode = "preview" | "save";

export interface IngestView {
  id: number;
  // The slug of the subject, and the folder name of the book.
  subject: string;
  book: string;
  title: string;
  mode: IngestMode | "fetch";
  chapters: number[];
  status: "running" | "done" | "stopped" | "failed";
  // The finished steps and all steps. A step is one model request. The total is an estimate.
  done: number;
  total: number;
  // The text of the current step, for example: Finding the concepts in chapter 4 of 12, "Joins".
  step: string;
  error: string | null;
  // True after a click on "Stop", until the run ends.
  stopping: boolean;
  // True for the download of a YouTube video or playlist.
  video: boolean;
  // The result of a finished download, or null for an ingest run.
  download: DownloadView | null;
}

// The result of a download: the pages and the images of an online book, or the transcripts of videos.
// The skipped items are the pages, images, or videos that the download did not get, with the reason.
export type DownloadView =
  | { kind: "web"; pages: number; words: number; images: number; skipped: { url: string; reason: string }[] }
  | { kind: "video"; videos: number; words: number; requests: number; cost: number | null; skipped: { url: string; reason: string }[] };

// The table of contents of an online book. The server keeps no state between the two requests of a download,
// so the app sends the table of contents back with the selected chapters.
export interface OnlineToc {
  title: string;
  language: string;
  startUrl: string;
  // Where the table of contents comes from: an llms.txt file, or the links of an HTML page.
  source: "llms.txt" | "html";
  tocUrl: string;
  // The pages of the book are in this folder, for example "https://docs.cakemail.com/en/docs/".
  scope: string;
  chapters: { title: string; pages: { title: string; url: string }[] }[];
}

// The answer for an address: the table of contents of an online book, or the facts of a YouTube video or playlist.
export type OnlineTocView =
  | {
      kind: "web";
      toc: OnlineToc;
      // The time of one page, for the estimate of the download time.
      secondsPerPage: number;
    }
  | { kind: "video"; video: VideoToc };

// The facts of a YouTube video or playlist. The app sends them back with the selected videos, as for an online book.
export interface VideoToc {
  kind: "video" | "playlist";
  // The id of the video or of the playlist, and its address.
  id: string;
  source: string;
  // The address of a playlist, if the address of one video also names a playlist.
  playlist: string | null;
  title: string;
  channel: string;
  // The videos of the playlist, or the one video.
  videos: VideoEntry[];
  // The YouTube chapters of one video. A playlist and a video with no chapters have none.
  chapters: { title: string; start: number }[];
  // The longest video that the tutor can transcribe, in seconds.
  maxSeconds: number;
  // The longest video that becomes one chapter. Its YouTube chapters become sections.
  oneChapterSeconds: number;
  // The video model from .env, or the reason that there is no video model.
  model: string | null;
  modelError: string | null;
  // The estimated cost of one second of video in dollars. If it is null, the note tells why.
  dollarsPerSecond: number | null;
  costNote: string | null;
}

export interface VideoEntry {
  id: string;
  title: string;
  // The length in seconds, or null if the playlist does not give it.
  duration: number | null;
  // True if the cache has the transcript, so that the video costs nothing.
  cached: boolean;
}

// The answer to the start of a download: the new run, or the EPUB file in data/web/ with the same title.
export type FetchStartView = { run: IngestView; existing: null } | { run: null; existing: { file: string; title: string } };

export interface ChapterPlan {
  number: number;
  title: string;
  sections: number;
  words: number;
  // The images that the model did not read yet.
  images: number;
  // The model requests of a run on this chapter. It is an estimate.
  requests: number;
  // True if the cache has the result of the extract and review stages.
  cached: boolean;
  // True if the chapter has concepts in the database. A run cannot select it.
  hasConcepts: boolean;
}

export interface ChapterReportView {
  number: number;
  title: string;
  sections: number;
  concepts: number;
  added: number;
  joined: number;
  emptySections: { sectionId: string; title: string; reason: string }[];
  // The sections with no answer from the model.
  missingSections: { sectionId: string; title: string }[];
  minorItems: { term: string; reason: string }[];
  quoteWarnings: { concept: string; sectionId: string; quote: string }[];
}

export interface IngestReportView {
  preview: boolean;
  // The modules and the concepts of the concept map after the run.
  modules: number;
  concepts: number;
  parseWarnings: string[];
  imageWarning: string | null;
  chapters: ChapterReportView[];
  // The concept map of a preview. It is null after a save.
  conceptMap: PreviewModule[] | null;
}

// A module of the preview concept map, with the concepts that have a source in the chapters of the preview.
export interface PreviewModule {
  // The number of the module on the concept map.
  position: number;
  name: string;
  concepts: {
    name: string;
    objective: string;
    kind: "knowledge" | "skill";
    level: "basic" | "intermediate" | "advanced";
    // A source for people to read, for example "Pro Git, 3.2 Branches in a Nutshell, p. 45".
    sources: { text: string; quoteFound: boolean }[];
    // The names of the prerequisites.
    needs: string[];
    // True for a concept that is on the concept map already. The preview joins its own concept to it.
    onMap: boolean;
  }[];
}

// The book page: the plan of a run, the last run, and its report.
export interface BookView {
  subject: { slug: string; name: string };
  slug: string;
  title: string;
  format: "epub" | "pdf";
  // True if the subject has the book in the database.
  saved: boolean;
  // The model from .env, or the reason that there is no model.
  model: string | null;
  modelError: string | null;
  // A problem that stops each run, for example a book that the parser cannot read. Then the plan has no chapters.
  problem: string | null;
  warnings: string[];
  chapters: ChapterPlan[];
  // The last run of the book in the app, and its report if it finished.
  run: IngestView | null;
  report: IngestReportView | null;
}

// A module of a subject, with the number of its concepts in each status.
export interface ModuleSummary {
  id: number;
  position: number;
  name: string;
  concepts: number;
  progress: StatusCounts;
}

// A point in a YouTube video: the video id and the time in seconds.
export interface VideoMoment {
  id: string;
  start: number;
}

export interface SourceRef {
  sectionId: number;
  // The section number in the book, for example "2.3".
  ref: string;
  book: string;
  // The number of the chapter in the tutor, and its title. The title can have its own number.
  chapter: number;
  chapterTitle: string;
  title: string;
  page: string | null;
  quote: string;
  // For a book from a video: the point in the video of the quote. Null for a book file or an online book.
  video: VideoMoment | null;
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
  // The open diagnosis of a concept that waits for its test, or null.
  diagnosis: number | null;
}

export interface ModuleView {
  id: number;
  position: number;
  name: string;
  concepts: ConceptView[];
}

export interface ConceptMapView {
  subject: { slug: string; name: string };
  modules: ModuleView[];
  openDiagnoses: OpenDiagnosis[];
}

export interface SectionView {
  id: number;
  book: string;
  chapterTitle: string;
  ref: string;
  title: string;
  page: string | null;
  markdown: string;
  // For a section from a video: the point in the video of its first paragraph. Null for other books.
  video: VideoMoment | null;
}

// Diagnosis

// "later" sets the concept back to "not started", so that the learner can decide later.
export type Mark = "test" | "learn" | "skip" | "later";
export type Choice = "learn" | "skip" | "keep";

export interface SelectionResult {
  // The session of the diagnosis, or null if no concept has the mark "test".
  sessionId: number | null;
  // True for a new session, which needs questions. False for an open diagnosis that keeps its questions and answers.
  newSession: boolean;
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
  subject: { slug: string; name: string };
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
  subject: { slug: string; name: string };
  items: QueueItem[];
  // True if the suggested order of the tutor is different from the current order.
  suggestionDiffers: boolean;
  // True if the order of the sections in the books is different from the current order.
  bookOrderDiffers: boolean;
  // The concepts of the subject that the learner did not choose yet, and the number of their modules.
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
  // For a book from a video: the point in the video of the quote. The database keeps the references without it.
  video: VideoMoment | null;
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
    subject: { slug: string; name: string };
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
  // True if the concept has a finished test. "Test me again" then uses its questions.
  hasFinishedTest: boolean;
  failedTests: number;
}

// The test after a lesson

export interface TestOutcome {
  passed: boolean;
  correct: number;
  total: number;
  // The finished tests of the concept that the learner failed, this test included.
  failedTests: number;
  hasPrerequisites: boolean;
  // After a pass: the next concept in the study queue, or null.
  next: { conceptId: number; name: string } | null;
}

export type AfterTestAction = "later" | "skip";

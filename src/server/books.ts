import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Db } from "../db/index.js";
import { normalizeSpace, slugify } from "../ingest/core/text.js";
import { sectionMismatch, type IngestReport } from "../ingest/ingest.js";
import { readBookSource } from "../ingest/parse.js";
import { countRequests, loadBook } from "../ingest/run.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { BookView, IngestReportView, PreviewModule } from "./api-types.js";
import { BOOK_FILE, chaptersWithConcepts, lastIngest, runningIngest, runText, toIngestView, type BookLocation } from "./ingests.js";

type SubjectRow = BookLocation["subject"];

// Subjects and books in the app: a new subject, the upload of a book file, and the data of the book page.

// The largest book file that the upload route accepts.
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function createSubject(db: Db, value: unknown): { slug: string; name: string } {
  const name = typeof value === "string" ? normalizeSpace(value) : "";
  if (!name) throw new TutorError("Type a name for the subject.");
  if (name.length > 100) throw new TutorError("The name of a subject can have 100 characters or fewer.");
  const slug = slugify(name);
  // The slug has only the letters a to z and digits. Without them, all names give the same slug.
  if (slug === "untitled" && name.toLowerCase() !== "untitled") {
    throw new TutorError("The name of a subject needs at least one letter from A to Z or one digit.");
  }
  const existing = db.prepare("SELECT name FROM subjects WHERE slug = ?").pluck().get(slug) as string | undefined;
  if (existing !== undefined) throw new TutorError(`The subject "${existing}" exists already.`, 409);
  db.prepare("INSERT INTO subjects (slug, name) VALUES (?, ?)").run(slug, name);
  return { slug, name };
}

// Keep an uploaded book file in the folder of its book. The result is the folder name of the book.
export async function addBook(db: Db, dataDir: string, subjectSlug: string, fileName: unknown, data: unknown): Promise<{ book: string }> {
  const subject = findSubject(db, subjectSlug);
  if (!Buffer.isBuffer(data) || data.length === 0) throw new TutorError("The request has no book file.");
  // Only the name of the file, with no folder and no unusual characters.
  const name = basename(String(fileName ?? "").replace(/\\/g, "/")).replace(/[^\w.\- ()]+/g, "-");
  if (!BOOK_FILE.test(name)) throw new TutorError("Select an EPUB file or a PDF file.");
  return storeBook(db, dataDir, subject, name, data);
}

// Add an EPUB file from data/web/ as a book, for example an online book from an earlier download.
export async function addWebBook(db: Db, dataDir: string, subjectSlug: string, fileName: unknown): Promise<{ book: string }> {
  const subject = findSubject(db, subjectSlug);
  const name = typeof fileName === "string" ? fileName : "";
  // Only a file name, with no folder, so that the file stays in data/web/.
  if (!/\.epub$/i.test(name) || basename(name) !== name || name.includes("\\")) throw new TutorError("Select an EPUB file in data/web/.");
  const file = join(dataDir, "web", name);
  if (!existsSync(file)) throw new TutorError(`The folder data/web/ has no file ${name}.`, 404);
  return storeBook(db, dataDir, subject, name, readFileSync(file));
}

export function findSubject(db: Db, slug: string): SubjectRow {
  const subject = db.prepare("SELECT id, slug, name FROM subjects WHERE slug = ?").get(slug) as SubjectRow | undefined;
  if (!subject) throw new TutorError(`The subject "${slug}" does not exist.`, 404);
  return subject;
}

// Parse a book file and keep it in the folder of its book, as the command does. The result is the folder name of the book.
// If the subject has the book already, the old file stays. A run then adds the chapters without concepts.
// A download calls this function at its end. Its own run is not a run on the book, so ownRun gives its id.
export async function storeBook(
  db: Db,
  dataDir: string,
  subject: SubjectRow,
  name: string,
  data: Uint8Array,
  ownRun?: number,
): Promise<{ book: string }> {
  let title: string;
  try {
    title = (await readBookSource(data, name)).title;
  } catch (error) {
    throw new TutorError(error instanceof Error ? error.message : String(error));
  }
  const slug = slugify(title);
  if (db.prepare("SELECT 1 FROM books WHERE subject_id = ? AND slug = ?").get(subject.id, slug)) return { book: slug };
  const running = runningIngest(db, subject.slug);
  if (running && running.id !== ownRun && running.book === slug) {
    throw new TutorError(`The tutor ${runText(running)} now. Wait for the end of the run.`, 409);
  }

  // A new file of a book that is not saved replaces the old file. The cached results stay.
  const dir = join(dataDir, "subjects", subject.slug, "books", slug);
  mkdirSync(dir, { recursive: true });
  for (const old of readdirSync(dir)) if (BOOK_FILE.test(old) && old !== name) rmSync(join(dir, old));
  writeFileSync(join(dir, name), data);
  return { book: slug };
}

// The preview concept map from its data file. A file from before the module numbers has all the concepts
// of the subject, not only the concepts of the preview. Then the report has no concept map.
function previewMap(text: string): PreviewModule[] | null {
  const modules = JSON.parse(text) as PreviewModule[];
  return modules.every((module) => typeof module.position === "number") ? modules : null;
}

// The report of the last finished run, from the files of the book.
function readReport(dir: string, preview: boolean): IngestReportView | null {
  const file = join(dir, preview ? "ingest-report.preview.json" : "ingest-report.json");
  if (!existsSync(file)) return null;
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as IngestReport;
    // A preview from before the data file has only the Markdown file. Then the report has no concept map.
    const mapFile = join(dir, "concept-map.preview.json");
    return {
      preview: report.preview,
      modules: report.modules,
      concepts: report.concepts,
      parseWarnings: report.parseWarnings.map((warning) => warning.message),
      imageWarning: report.imageWarning ?? null,
      chapters: report.chapters.map((chapter) => ({
        number: chapter.number,
        title: chapter.title,
        sections: chapter.sections,
        concepts: chapter.concepts,
        added: chapter.added,
        joined: chapter.joined,
        emptySections: chapter.emptySections,
        missingSections: chapter.missingSections,
        minorItems: chapter.minorItems.map(({ term, reason }) => ({ term, reason })),
        quoteWarnings: chapter.quoteWarnings,
      })),
      conceptMap: preview && existsSync(mapFile) ? previewMap(readFileSync(mapFile, "utf8")) : null,
    };
  } catch {
    // A broken report file counts as no report.
    return null;
  }
}

export interface ModelInfo {
  name: string | null;
  error: string | null;
}

// The book page: the chapters with the model requests of a run, the last run, and its report.
export async function bookView(db: Db, dataDir: string, book: BookLocation, model: ModelInfo, stopping: (id: number) => boolean): Promise<BookView> {
  const { subject } = book;
  const run = lastIngest(db, subject.id, book.slug);
  const view: BookView = {
    subject: { slug: subject.slug, name: subject.name },
    slug: book.slug,
    title: book.row?.title ?? run?.title ?? book.slug,
    format: extname(book.file ?? "").toLowerCase() === ".pdf" ? "pdf" : "epub",
    saved: book.row !== null,
    model: model.name,
    modelError: model.error,
    problem: null,
    warnings: [],
    chapters: [],
    run: run ? toIngestView(run, stopping(run.id)) : null,
    report: run?.status === "done" && run.mode !== "fetch" ? readReport(book.dir, run.mode === "preview") : null,
  };
  if (!book.file) {
    // A download in the app writes the book file only at its end.
    const problem =
      run?.mode === "fetch"
        ? "The tutor has no EPUB file of this book, because the download did not finish."
        : `The folder ${book.dir} has no copy of the book file.`;
    return { ...view, problem };
  }

  let loaded;
  try {
    loaded = await loadBook(dataDir, subject.name, readFileSync(book.file), book.file);
  } catch (error) {
    return { ...view, problem: error instanceof Error ? error.message : String(error) };
  }
  const withConcepts = book.row ? chaptersWithConcepts(db, book.row.id) : [];
  const counts = new Map(countRequests(dataDir, subject.name, loaded).chapters.map((count) => [count.chapter, count]));
  return {
    ...view,
    title: loaded.book.title,
    problem: book.row ? sectionMismatch(db, dataDir, subject.name, loaded.book) : null,
    warnings: loaded.book.warnings.map((warning) => warning.message),
    chapters: loaded.book.chapters.map((chapter) => {
      const count = counts.get(chapter.number);
      return {
        number: chapter.number,
        title: chapter.title,
        sections: chapter.sections.length,
        words: chapter.words,
        images: count?.images ?? 0,
        requests: count?.requests ?? 0,
        cached: count?.cached ?? false,
        hasConcepts: withConcepts.includes(chapter.number),
      };
    }),
  };
}

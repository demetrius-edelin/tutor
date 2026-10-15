import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Db } from "../db/index.js";
import { IngestStopped } from "../ingest/ingest.js";
import { loadBook, runIngest } from "../ingest/run.js";
import type { LlmClient } from "../llm/index.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { IngestMode, IngestView } from "./api-types.js";

// Ingest in the app. A run works in the background, in the server process, and the table "ingests" keeps its progress.
// Only one run works at a time, in all subjects, because two runs on one subject can overwrite the merge result of each other.

export const BOOK_FILE = /\.(epub|pdf)$/i;

export interface BookLocation {
  subject: { id: number; slug: string; name: string };
  // The folder name of the book, and the folder.
  slug: string;
  dir: string;
  // The row of a saved book, or null.
  row: { id: number; title: string } | null;
  // The copy of the book file in the folder of the book, or null if the folder has no book file.
  file: string | null;
}

interface IngestRow {
  id: number;
  subject: string;
  book: string;
  title: string;
  mode: IngestView["mode"];
  chapters: string;
  status: IngestView["status"];
  done: number;
  total: number;
  step: string;
  error: string | null;
}

const SELECT_INGEST = `SELECT i.id, s.slug AS subject, i.book, i.title, i.mode, i.chapters, i.status, i.done, i.total, i.step, i.error
  FROM ingests i JOIN subjects s ON s.id = i.subject_id`;

export function toIngestView(row: IngestRow, stopping: boolean): IngestView {
  return { ...row, chapters: JSON.parse(row.chapters) as number[], stopping: stopping && row.status === "running" };
}

export function ingestRow(db: Db, id: number): IngestRow | undefined {
  return db.prepare(`${SELECT_INGEST} WHERE i.id = ?`).get(id) as IngestRow | undefined;
}

// The last run of a book in the app.
export function lastIngest(db: Db, subjectId: number, book: string): IngestRow | undefined {
  return db.prepare(`${SELECT_INGEST} WHERE i.subject_id = ? AND i.book = ? ORDER BY i.id DESC LIMIT 1`).get(subjectId, book) as IngestRow | undefined;
}

// The run in progress, in one subject or in all subjects.
export function runningIngest(db: Db, subjectSlug?: string): IngestRow | undefined {
  return (
    subjectSlug === undefined
      ? db.prepare(`${SELECT_INGEST} WHERE i.status = 'running'`).get()
      : db.prepare(`${SELECT_INGEST} WHERE i.status = 'running' AND s.slug = ?`).get(subjectSlug)
  ) as IngestRow | undefined;
}

// A new server has no runs in progress. A run that is still "running" lost its job, for example after a restart.
export function failInterruptedIngests(db: Db): void {
  db.prepare("UPDATE ingests SET status = 'failed', error = ? WHERE status = 'running'").run(
    "The tutor stopped during the run. A new run takes the finished chapters from the cache.",
  );
}

// The chapters of a saved book with concepts.
export function chaptersWithConcepts(db: Db, bookId: number): number[] {
  return db
    .prepare("SELECT DISTINCT s.chapter FROM concept_sources cs JOIN sections s ON s.id = cs.section_id WHERE s.book_id = ? ORDER BY s.chapter")
    .pluck()
    .all(bookId) as number[];
}

// Find a book of a subject: a saved book, or a folder with a book file, for example after an upload.
export function findBook(db: Db, dataDir: string, subjectSlug: string, bookSlug: string): BookLocation | undefined {
  const subject = db.prepare("SELECT id, slug, name FROM subjects WHERE slug = ?").get(subjectSlug) as BookLocation["subject"] | undefined;
  // The folder name comes from the address. It must be a slug, so that the folder stays in the folder of the subject.
  if (!subject || !/^[a-z0-9-]+$/.test(bookSlug)) return undefined;
  const dir = join(dataDir, "subjects", subject.slug, "books", bookSlug);
  const row = db.prepare("SELECT id, title, file FROM books WHERE subject_id = ? AND slug = ?").get(subject.id, bookSlug) as
    | { id: number; title: string; file: string }
    | undefined;
  if (row) {
    const root = resolve(dataDir);
    const file = resolve(root, row.file);
    const found = file.startsWith(root + sep) && existsSync(file) ? file : null;
    return { subject, slug: bookSlug, dir, row: { id: row.id, title: row.title }, file: found };
  }
  if (!existsSync(dir)) return undefined;
  // The newest book file. An upload replaces the old file, but a preview of the command can leave a second file.
  const files = readdirSync(dir)
    .filter((name) => BOOK_FILE.test(name))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ? { subject, slug: bookSlug, dir, row: null, file: files[0] } : undefined;
}

export interface StartOptions {
  db: Db;
  llm: LlmClient;
  dataDir: string;
  book: BookLocation;
  mode: unknown;
  chapters: unknown;
  // The ids of the runs that the user stopped.
  stops: Set<number>;
}

// Start a run on some chapters of a book. The result has the job, which the server runs in the background.
export function startIngest({ db, llm, dataDir, book, mode, chapters, stops }: StartOptions): { id: number; job: Promise<void> } {
  if (mode !== "preview" && mode !== "save") throw new TutorError('The mode of a run must be "preview" or "save".');
  if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every((n) => Number.isInteger(n) && n > 0)) {
    throw new TutorError("Select at least one chapter.");
  }
  if (!book.file) throw new TutorError(`The folder ${book.dir} has no book file.`, 404);
  const running = runningIngest(db);
  if (running) throw new TutorError(`The tutor runs ingest on "${running.title}" now. Only one run can work at a time.`, 409);
  const selected = [...new Set(chapters as number[])].sort((a, b) => a - b);
  if (book.row) {
    const done = chaptersWithConcepts(db, book.row.id);
    const again = selected.filter((n) => done.includes(n));
    if (again.length > 0) {
      throw new TutorError(`Chapter ${again.join(", ")} has concepts already. To ingest a chapter again, use npm run ingest with --replace.`);
    }
  }
  // The title of a book that is not saved comes from the parse at the start of the job.
  const title = book.row?.title ?? lastIngest(db, book.subject.id, book.slug)?.title ?? book.slug;
  const id = Number(
    db
      .prepare("INSERT INTO ingests (subject_id, book, file, title, mode, chapters, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
      .run(book.subject.id, book.slug, relative(dataDir, book.file), title, mode, JSON.stringify(selected)).lastInsertRowid,
  );
  return { id, job: runJob(db, llm, dataDir, id, book, mode, selected, stops) };
}

async function runJob(
  db: Db,
  llm: LlmClient,
  dataDir: string,
  id: number,
  book: BookLocation,
  mode: IngestMode,
  chapters: number[],
  stops: Set<number>,
): Promise<void> {
  const progress = db.prepare("UPDATE ingests SET done = ?, total = ?, step = ? WHERE id = ?");
  try {
    const file = book.file!;
    const loaded = await loadBook(dataDir, book.subject.name, readFileSync(file), file);
    db.prepare("UPDATE ingests SET title = ? WHERE id = ?").run(loaded.book.title, id);
    const unknown = chapters.filter((n) => !loaded.book.chapters.some((chapter) => chapter.number === n));
    if (unknown.length > 0) throw new Error(`The book has no chapter ${unknown.join(", ")}.`);
    await runIngest({
      llm,
      db,
      dataDir,
      subjectName: book.subject.name,
      bookFile: file,
      loaded,
      chapters,
      preview: mode === "preview",
      progress: ({ text, done, total }) => progress.run(done, total, text, id),
      stopped: () => stops.has(id),
    });
    db.prepare("UPDATE ingests SET status = 'done', done = total, step = '' WHERE id = ?").run(id);
  } catch (error) {
    if (error instanceof IngestStopped) {
      db.prepare("UPDATE ingests SET status = 'stopped' WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE ingests SET status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), id);
    }
  } finally {
    stops.delete(id);
  }
}

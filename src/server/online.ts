import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { slugify } from "../ingest/core/text.js";
import { isYoutubeUrl } from "../ingest/video/youtube.js";
import { bookTitle, fetchBook, FetchStopped } from "../ingest/web/fetch.js";
import { Downloader, type Fetcher } from "../ingest/web/http.js";
import { findToc, inScope, TocError, type WebToc } from "../ingest/web/toc.js";
import type { LlmClient } from "../llm/index.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { DownloadView, FetchStartView, OnlineTocView } from "./api-types.js";
import { findSubject, storeBook } from "./books.js";
import { ingestRow, runningIngest, runText, toIngestView, type BookLocation } from "./ingests.js";

// Online books in the app: find the table of contents, and download the selected chapters into an EPUB file in data/web/.
// A download is a run with the mode "fetch". The rule of one run at a time applies to it too.

export interface WebAccess {
  fetcher: Fetcher;
  // The pause between two requests to a site.
  pauseMs: number;
}

const APP_TOC_HINT = 'Type the address of a page that lists the pages in the field "Table of contents".';

// A web address from the form, or null for an empty field. An address with no scheme gets "https://".
function webAddress(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // The message below gives the reason.
  }
  throw new TutorError(`"${text}" is not a web address. A web address starts with https://.`);
}

// The reason of a failed request to a site, for example "ENOTFOUND" for a host that does not exist.
function networkProblem(error: unknown): string | null {
  if (error instanceof Error && error.name === "TimeoutError") return "the site did not answer in 30 seconds";
  if (!(error instanceof TypeError)) return null;
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" ? code : error.message;
}

// Find the table of contents of an online book: first in an llms.txt file, then in the links of the start page.
// The links need one model request. The app waits for the answer, as for a new lesson.
export async function findOnlineToc(web: WebAccess, llm: () => LlmClient, body: { url?: unknown; toc?: unknown }): Promise<OnlineTocView> {
  const startUrl = webAddress(body.url);
  if (!startUrl) throw new TutorError("Type the address of the online book.");
  if (isYoutubeUrl(startUrl)) {
    throw new TutorError('The app cannot add a YouTube video yet. Get the transcript with npm run fetch, then add the EPUB file with "Add a book".');
  }
  const tocUrl = webAddress(body.toc);
  const download = new Downloader(web.fetcher, { pauseMs: web.pauseMs });
  try {
    const toc = await findToc({ startUrl, ...(tocUrl ? { tocUrl } : {}), download, llm, tocHint: APP_TOC_HINT });
    return { toc, secondsPerPage: web.pauseMs / 1000 };
  } catch (error) {
    if (error instanceof TocError) throw new TutorError(error.message);
    const problem = networkProblem(error);
    if (problem) throw new TutorError(`The tutor cannot download ${tocUrl ?? startUrl}: ${problem}.`, 502);
    throw error;
  }
}

const TocSchema = z.object({
  title: z.string().min(1),
  language: z.string(),
  startUrl: z.string(),
  source: z.enum(["llms.txt", "html"]),
  tocUrl: z.string(),
  scope: z.string(),
  chapters: z.array(z.object({ title: z.string(), pages: z.array(z.object({ title: z.string(), url: z.string() })).min(1) })).min(1),
});

const isWebUrl = (text: string) => {
  try {
    return ["http:", "https:"].includes(new URL(text).protocol);
  } catch {
    return false;
  }
};

// The table of contents comes back from the app. The server downloads only the pages in the scope of the start address.
export function checkToc(value: unknown): WebToc {
  const parsed = TocSchema.safeParse(value);
  if (!parsed.success) throw new TutorError("The table of contents is not valid. Find the chapters again.");
  const toc = parsed.data;
  if (!isWebUrl(toc.scope) || !toc.scope.endsWith("/") || !isWebUrl(toc.startUrl) || new URL(toc.startUrl).origin !== new URL(toc.scope).origin) {
    throw new TutorError("The scope of the table of contents is not valid. Find the chapters again.");
  }
  for (const page of toc.chapters.flatMap((chapter) => chapter.pages)) {
    if (!isWebUrl(page.url) || !inScope(page.url, toc.scope)) {
      throw new TutorError(`The page ${page.url} is not in ${toc.scope}. Find the chapters again.`);
    }
  }
  return toc;
}

export interface FetchStartOptions {
  db: Db;
  dataDir: string;
  web: WebAccess;
  subjectSlug: string;
  // The table of contents, the selected chapters, and "again" to replace an EPUB file with the same title.
  body: { toc?: unknown; chapters?: unknown; again?: unknown };
  // The ids of the runs that the user stopped.
  stops: Set<number>;
}

// Start the download of some chapters of an online book. If data/web/ has an EPUB file with the same title,
// the download does not start, and the answer gives the file. With "again", the download replaces the file.
export function startFetch({ db, dataDir, web, subjectSlug, body, stops }: FetchStartOptions): { view: FetchStartView; job: Promise<void> | null } {
  const subject = findSubject(db, subjectSlug);
  const toc = checkToc(body.toc);
  const { chapters } = body;
  if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every((n) => Number.isInteger(n) && n > 0)) {
    throw new TutorError("Select at least one chapter.");
  }
  const selected = [...new Set(chapters as number[])].sort((a, b) => a - b);
  const unknown = selected.filter((n) => n > toc.chapters.length);
  if (unknown.length > 0) throw new TutorError(`The site has ${toc.chapters.length} chapters. There is no chapter ${unknown.join(", ")}.`);

  // The title gives the file name, as in the command.
  const title = bookTitle(toc, selected);
  const file = join(dataDir, "web", `${slugify(title)}.epub`);
  if (existsSync(file) && body.again !== true) return { view: { run: null, existing: { file: basename(file), title } }, job: null };
  const running = runningIngest(db);
  if (running) throw new TutorError(`The tutor ${runText(running)} now. Only one run can work at a time.`, 409);

  const pages = selected.reduce((count, n) => count + toc.chapters[n - 1]!.pages.length, 0);
  const id = Number(
    db
      .prepare("INSERT INTO ingests (subject_id, book, file, title, mode, chapters, status, total) VALUES (?, ?, ?, ?, 'fetch', ?, 'running', ?)")
      .run(subject.id, slugify(title), relative(dataDir, file), title, JSON.stringify(selected), pages).lastInsertRowid,
  );
  return {
    view: { run: toIngestView(ingestRow(db, id)!, false), existing: null },
    job: fetchJob({ db, dataDir, web, id, subject, toc, chapters: selected, title, file, stops }),
  };
}

interface FetchJob {
  db: Db;
  dataDir: string;
  web: WebAccess;
  id: number;
  subject: BookLocation["subject"];
  toc: WebToc;
  chapters: number[];
  title: string;
  // The new EPUB file in data/web/.
  file: string;
  stops: Set<number>;
}

// Download the pages, write the EPUB file, and keep a copy in the folder of the book, as for an upload.
// A stopped download writes no EPUB file.
async function fetchJob({ db, dataDir, web, id, subject, toc, chapters, title, file, stops }: FetchJob): Promise<void> {
  const progress = db.prepare("UPDATE ingests SET done = ?, total = ?, step = ? WHERE id = ?");
  try {
    const result = await fetchBook({
      toc,
      chapters,
      download: new Downloader(web.fetcher, { pauseMs: web.pauseMs }),
      title,
      progress: ({ text, done, total }) => progress.run(done, total, text, id),
      stopped: () => stops.has(id),
    });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, result.epub);
    const { book } = await storeBook(db, dataDir, subject, basename(file), result.epub, id);
    const download: DownloadView = { pages: result.pages, words: result.words, images: result.images, skipped: result.skipped };
    db.prepare("UPDATE ingests SET status = 'done', done = total, step = '', book = ?, result = ? WHERE id = ?").run(book, JSON.stringify(download), id);
  } catch (error) {
    if (error instanceof FetchStopped) {
      db.prepare("UPDATE ingests SET status = 'stopped' WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE ingests SET status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), id);
    }
  } finally {
    stops.delete(id);
  }
}

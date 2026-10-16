import { z } from "zod";
import type { Db } from "../db/index.js";
import { isYoutubeUrl } from "../ingest/video/youtube.js";
import { bookTitle, fetchBook } from "../ingest/web/fetch.js";
import { Downloader, type Fetcher } from "../ingest/web/http.js";
import { findToc, inScope, TocError, type WebToc } from "../ingest/web/toc.js";
import type { LlmClient } from "../llm/index.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { FetchStartView, OnlineTocView } from "./api-types.js";
import { findSubject } from "./books.js";
import { startDownload, type DownloadPlan } from "./downloads.js";
import { findVideoToc, startVideoFetch, type VideoAccess } from "./videos.js";

// Online books in the app: find the table of contents, and download the selected chapters into an EPUB file in data/web/.
// A YouTube address goes to the videos. See videos.ts.

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

export interface OnlineAccess {
  web: WebAccess;
  video: VideoAccess;
  dataDir: string;
}

// Find the table of contents of an online book: first in an llms.txt file, then in the links of the start page.
// The links need one model request. The app waits for the answer, as for a new lesson.
// For a YouTube address, the answer has the facts of the video or of the playlist.
export async function findOnlineToc(access: OnlineAccess, llm: () => LlmClient, body: { url?: unknown; toc?: unknown }): Promise<OnlineTocView> {
  const startUrl = webAddress(body.url);
  if (!startUrl) throw new TutorError("Type the address of the online book or video.");
  const tocUrl = webAddress(body.toc);
  if (isYoutubeUrl(startUrl)) {
    if (tocUrl) throw new TutorError('The field "Table of contents" does not apply to a YouTube address. Clear the field.');
    return { kind: "video", video: await findVideoToc(access.video, access.dataDir, startUrl) };
  }
  const { web } = access;
  const download = new Downloader(web.fetcher, { pauseMs: web.pauseMs });
  try {
    const toc = await findToc({ startUrl, ...(tocUrl ? { tocUrl } : {}), download, llm, tocHint: APP_TOC_HINT });
    return { kind: "web", toc, secondsPerPage: web.pauseMs / 1000 };
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
  access: OnlineAccess;
  subjectSlug: string;
  // An online book: the table of contents. YouTube: the facts of the video or of the playlist.
  // Also the selected chapters or videos, and "again" to replace an EPUB file with the same title.
  body: { toc?: unknown; video?: unknown; chapters?: unknown; again?: unknown };
  // The ids of the runs that the user stopped.
  stops: Set<number>;
}

// Start the download of some chapters of an online book, or of the videos of a YouTube address.
export function startFetch({ db, access, subjectSlug, body, stops }: FetchStartOptions): { view: FetchStartView; job: Promise<void> | null } {
  const subject = findSubject(db, subjectSlug);
  const { dataDir, web } = access;
  if (body.video !== undefined) return startVideoFetch({ db, dataDir, video: access.video, subject, body, stops });

  const toc = checkToc(body.toc);
  const { chapters } = body;
  if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every((n) => Number.isInteger(n) && n > 0)) {
    throw new TutorError("Select at least one chapter.");
  }
  const selected = [...new Set(chapters as number[])].sort((a, b) => a - b);
  const unknown = selected.filter((n) => n > toc.chapters.length);
  if (unknown.length > 0) throw new TutorError(`The site has ${toc.chapters.length} chapters. There is no chapter ${unknown.join(", ")}.`);

  const title = bookTitle(toc, selected);
  const plan: DownloadPlan = {
    title,
    source: toc.startUrl,
    chapters: selected,
    total: selected.reduce((count, n) => count + toc.chapters[n - 1]!.pages.length, 0),
    download: async (progress, stopped) => {
      const download = new Downloader(web.fetcher, { pauseMs: web.pauseMs });
      const result = await fetchBook({ toc, chapters: selected, download, title, progress, stopped });
      return { epub: result.epub, result: { kind: "web", pages: result.pages, words: result.words, images: result.images, skipped: result.skipped } };
    },
  };
  return startDownload({ db, dataDir, subject, plan, again: body.again, stops });
}

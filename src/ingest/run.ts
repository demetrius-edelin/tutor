import { buildBook } from "./core/book.js";
import type { BookSource } from "./core/source.js";
import type { ParsedBook } from "./core/types.js";
import { cachedImageText, imageCacheFile, imagesToRead, readImages } from "./images.js";
import type { Db } from "../db/index.js";
import { bookDir, bookSlugFor, cachedChapters, ingestBook, IngestStopped, selectedInputs, type IngestOptions, type IngestReport, type IngestStep } from "./ingest.js";
import { readBookSource } from "./parse.js";
import { requestsFor } from "./stages/digest.js";

// The steps around ingestBook, for the command and for the server: parse the book with the cached image texts,
// count the model requests, read the images, and build the book again with the new image texts.

export interface LoadedBook {
  source: BookSource;
  // The book with the image texts from the cache.
  book: ParsedBook;
  // The folder name of the book in the subject.
  slug: string;
  // The cache file of the image texts, in the folder of the book.
  cacheFile: string;
}

// slug: the folder name of the book, for example from the address of the book page. Without it, the name comes from the title.
export async function loadBook(db: Db, dataDir: string, subjectName: string, data: Uint8Array, fileName: string, slug?: string): Promise<LoadedBook> {
  const source = await readBookSource(data, fileName);
  const bookSlug = slug ?? bookSlugFor(db, dataDir, subjectName, source.title);
  const cacheFile = imageCacheFile(bookDir(dataDir, subjectName, bookSlug));
  return { source, book: buildBook(source, { imageText: cachedImageText(cacheFile) }), slug: bookSlug, cacheFile };
}

export interface ChapterRequests {
  chapter: number;
  // True if the cache has the result of the extract and review stages.
  cached: boolean;
  // The images that the model did not read yet.
  images: number;
  // The images, the extract and review stages if the chapter is not in the cache, and one merge request.
  requests: number;
}

export interface RequestCount {
  chapters: ChapterRequests[];
  // The images to read in all the selected chapters. An image in two chapters counts one time.
  images: number;
  requests: number;
}

// The model requests of a run on the selected chapters and sections, or on all chapters.
// The extract and review stages count without the second requests, so the number is an estimate.
export function countRequests(
  dataDir: string,
  subjectName: string,
  { book, slug, cacheFile }: LoadedBook,
  chapters?: number[],
  sections?: string[],
  fresh = false,
): RequestCount {
  const inputs = selectedInputs(book, chapters, sections);
  const cached = fresh ? new Set<number>() : cachedChapters(dataDir, subjectName, slug, book, inputs);
  const perChapter = inputs.map((input) => {
    const images = imagesToRead(book, cacheFile, undefined, input.sections.map((section) => section.id)).length;
    const inCache = cached.has(input.number);
    return { chapter: input.number, cached: inCache, images, requests: (inCache ? 0 : requestsFor(input)) + 1 + images };
  });
  const images = imagesToRead(book, cacheFile, chapters, sections).length;
  return { chapters: perChapter, images, requests: perChapter.reduce((total, item) => total + item.requests - item.images, 0) + images };
}

// The progress of a run. A step is one model request: one image, one extract or review request, or one merge.
// The total is the estimate of countRequests, without the second requests after a bad answer.
export interface RunProgress {
  text: string;
  done: number;
  total: number;
}

export interface RunOptions extends Omit<IngestOptions, "book" | "bookSlug" | "progress" | "imageWarning"> {
  loaded: LoadedBook;
  progress?: (progress: RunProgress) => void;
  // Called with a problem of the images, before the chapters start.
  warn?: (message: string) => void;
}

// Read the images of the selected chapters that are not in the cache. Then ingest the book with the image texts.
export async function runIngest(options: RunOptions): Promise<IngestReport> {
  const { loaded, progress, warn, ...ingest } = options;
  const count = countRequests(options.dataDir, options.subjectName, loaded, options.chapters, options.sections, options.fresh);
  const toRead = count.images;
  const total = count.requests;
  let book = loaded.book;
  let imageWarning: string | null = null;
  if (toRead > 0) {
    progress?.({ text: `Reading the images: 0 of ${toRead}.`, done: 0, total });
    const report = await readImages(options.llm, book, loaded.cacheFile, {
      ...(options.chapters ? { chapters: options.chapters } : {}),
      ...(options.sections ? { sections: options.sections } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.stopped ? { stopped: options.stopped } : {}),
      onImage: (tried) => progress?.({ text: `Reading the images: ${tried} of ${toRead}.`, done: tried, total }),
    });
    if (options.stopped?.()) throw new IngestStopped();
    imageWarning = report.warning;
    if (imageWarning) warn?.(imageWarning);
    book = buildBook(loaded.source, { imageText: report.text });
  }
  // Each progress event starts one more request, so the requests before it are done.
  let started = 0;
  return ingestBook({
    ...ingest,
    book,
    bookSlug: loaded.slug,
    imageWarning,
    progress: (step) => progress?.({ text: stepText(step), done: Math.min(toRead + started++, total), total }),
  });
}

function stepText(step: IngestStep): string {
  const chapter = `chapter ${step.index + 1} of ${step.count}, "${step.title}"`;
  const part = step.parts > 1 ? ` (part ${step.part} of ${step.parts})` : "";
  if (step.stage === "extract") return `Finding the concepts in ${chapter}${part}.`;
  if (step.stage === "review") return `Checking the concepts of ${chapter} against its key terms${part}.`;
  return `Adding the concepts of ${chapter} to the concept map.`;
}

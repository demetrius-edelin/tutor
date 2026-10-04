import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { LlmClient } from "../llm/index.js";
import { normalizeSpace } from "./core/text.js";
import type { ParsedBook } from "./core/types.js";

// Before ingest finds the concepts, the model reads each image of the book one time: code, a table, or a description.
// The text then replaces the image in the section. A cache keeps each result, so an image costs one model call only one time.

export const IMAGE_SYSTEM = `You read one image from a book. Return the content of the image as text.
- If the image shows code, a query, a command, or the output of a program, set "kind" to "code". Copy the text exactly, with the same lines and indents. Set "language" to the name of the programming language in lower case, or to "" if you do not know it.
- If the image shows a table, set "kind" to "table". Write the table in Markdown.
- If the image shows something else, for example a diagram or a photo, set "kind" to "other". Describe the content in one sentence.
- Do not correct errors in the image. Do not add an explanation.`;

const IMAGE_PROMPT = "Return the content of this image.";

const readingSchema = z.object({
  kind: z.enum(["code", "table", "other"]),
  language: z.string(),
  text: z.string(),
});
export type ImageReading = z.infer<typeof readingSchema>;

// Anthropic accepts an image of at most 5 MB. A larger image keeps its placeholder.
const MAX_IMAGE_BYTES = 4_000_000;
// The number of model calls at the same time.
const PARALLEL_CALLS = 4;
// After this number of failed calls in a row, the model probably does not accept images.
const MAX_FAILURES_IN_A_ROW = 3;

export function imageCacheFile(bookDir: string): string {
  return join(bookDir, "work", "images.json");
}

// The Markdown that replaces an image in a section, or null for an empty result.
// The text tells the reader that the tutor read the image, because the model can make an error.
export function imageMarkdown(reading: ImageReading): string | null {
  const text = reading.text.replace(/^\n+|\s+$/g, "");
  if (!text.trim()) return null;
  if (reading.kind === "code") {
    const fence = text.includes("```") ? "~~~~" : "```";
    const language = /^[\w+#.-]+$/.test(reading.language.trim()) ? reading.language.trim().toLowerCase() : "";
    return `_The tutor read this code from an image:_\n\n${fence}${language}\n${text}\n${fence}`;
  }
  if (reading.kind === "table") return `_The tutor read this table from an image:_\n\n${text.trim()}`;
  return `[Image: ${normalizeSpace(text)}]`;
}

function loadCache(file: string): Record<string, ImageReading> {
  if (!existsSync(file)) return {};
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const valid: Record<string, ImageReading> = {};
    for (const [id, reading] of Object.entries(cache)) {
      const result = readingSchema.safeParse(reading);
      if (result.success) valid[id] = result.data;
    }
    return valid;
  } catch {
    // A broken cache file counts as no cache.
    return {};
  }
}

// The text of the images in the cache, by image id. It needs no model call.
export function cachedImageText(cacheFile: string): Map<string, string> {
  const text = new Map<string, string>();
  for (const [id, reading] of Object.entries(loadCache(cacheFile))) {
    const markdown = imageMarkdown(reading);
    if (markdown !== null) text.set(id, markdown);
  }
  return text;
}

// The ids of the images in the chapters, or in the selected chapters only.
export function imageIds(book: ParsedBook, chapters?: number[]): string[] {
  const selected = book.chapters.filter((chapter) => !chapters || chapters.includes(chapter.number));
  return [...new Set(selected.flatMap((chapter) => chapter.sections.flatMap((section) => section.images)))];
}

// The images of the chapters that the model did not read yet.
export function imagesToRead(book: ParsedBook, cacheFile: string, chapters?: number[]): string[] {
  const cache = loadCache(cacheFile);
  return imageIds(book, chapters).filter((id) => !cache[id]);
}

export interface ImageReport {
  // The images of the selected chapters.
  total: number;
  // The images from the cache, and the images that the model read in this run.
  cached: number;
  read: number;
  // The text of each image that the model read, in this run or before, by image id.
  text: Map<string, string>;
  // A problem for the user, or null.
  warning: string | null;
}

export interface ReadImagesOptions {
  // Read only the images of these chapters.
  chapters?: number[];
  log?: (line: string) => void;
}

// The model reads the images of the chapters that are not in the cache. The cache file gets each result at once,
// so a stopped run loses no result. If the calls fail, the sections keep the placeholders of these images.
export async function readImages(llm: LlmClient, book: ParsedBook, cacheFile: string, options: ReadImagesOptions = {}): Promise<ImageReport> {
  const log = options.log ?? (() => {});
  const ids = imageIds(book, options.chapters);
  const cache = loadCache(cacheFile);
  const todo = ids.filter((id) => !cache[id]);
  const tooLarge = todo.filter((id) => book.images.get(id)!.data.length > MAX_IMAGE_BYTES);
  const queue = todo.filter((id) => !tooLarge.includes(id));
  const save = () => {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
  };

  let read = 0;
  let failuresInARow = 0;
  let firstError: string | null = null;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && failuresInARow < MAX_FAILURES_IN_A_ROW; id = queue.shift()) {
      try {
        const reading = await llm.object({ system: IMAGE_SYSTEM, images: [book.images.get(id)!], prompt: IMAGE_PROMPT, schema: readingSchema });
        cache[id] = reading;
        save();
        read++;
        failuresInARow = 0;
        log(`Image ${read} of ${todo.length - tooLarge.length}: ${reading.kind}`);
      } catch (error) {
        failuresInARow++;
        firstError ??= error instanceof Error ? error.message : String(error);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_CALLS }, worker));

  const problems: string[] = [];
  const unread = todo.length - tooLarge.length - read;
  if (unread > 0) {
    problems.push(`The model did not read ${unread} images. The first error: ${firstError} To try again, run the command again.`);
  }
  if (tooLarge.length > 0) problems.push(`${tooLarge.length} images are too large for the model.`);
  if (problems.length > 0) problems.push("The sections keep the alternative text of these images.");
  return {
    total: ids.length,
    cached: ids.length - todo.length,
    read,
    text: cachedImageText(cacheFile),
    warning: problems.length > 0 ? problems.join(" ") : null,
  };
}

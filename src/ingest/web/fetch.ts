import { imageId } from "../core/png.js";
import { bodyText, RobotsError, type Downloader } from "./http.js";
import { writeEpub, type EpubChapter, type EpubImage } from "./epub.js";
import { cleanMarkdownPage, cleanPage, isMarkdown, type CleanPage } from "./page.js";
import type { WebToc } from "./toc.js";

// The largest image to keep. A larger file is a photo or an animation, not a code listing or a diagram.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Two pages with this part of their word sequences in common have the same text.
const SAME_TEXT = 0.8;
// A page with fewer words is too short for the check. Short pages, for example a list of links, can look the same.
const MIN_COMPARE_WORDS = 50;

export interface FetchBookOptions {
  toc: WebToc;
  // The numbers of the chapters to download, from 1.
  chapters: number[];
  download: Downloader;
  // The title of the book. The default is the title of the site.
  title?: string;
  date?: Date;
  log?: (line: string) => void;
}

export interface FetchBookResult {
  title: string;
  epub: Uint8Array;
  pages: number;
  words: number;
  images: number;
  // The pages and images that the command did not download, with the reason.
  skipped: { url: string; reason: string }[];
}

// The title of a book with some chapters of the site. Two selections of the same site must give two titles,
// because the title gives the file name and the folder of the book in a subject.
export function bookTitle(toc: WebToc, chapters: number[]): string {
  if (chapters.length === toc.chapters.length) return toc.title;
  if (chapters.length <= 3) return `${toc.title} - ${chapters.map((number) => toc.chapters[number - 1]!.title).join(", ")}`;
  return `${toc.title} - chapters ${formatList(chapters)}`;
}

// 1,2,3,5 gives "1-3, 5".
export function formatList(numbers: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    parts.push(j > i ? `${numbers[i]}-${numbers[j]}` : `${numbers[i]}`);
    i = j;
  }
  return parts.join(", ");
}

const IMAGE_TYPES: { mediaType: EpubImage["mediaType"]; extension: string; test: (data: Uint8Array) => boolean }[] = [
  { mediaType: "image/png", extension: "png", test: (d) => d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 },
  { mediaType: "image/jpeg", extension: "jpg", test: (d) => d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff },
  { mediaType: "image/gif", extension: "gif", test: (d) => d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 },
  {
    mediaType: "image/webp",
    extension: "webp",
    test: (d) => String.fromCharCode(...d.slice(0, 4)) === "RIFF" && String.fromCharCode(...d.slice(8, 12)) === "WEBP",
  },
];

// The sequences of 5 words in a text.
export function shingles(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const result = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) result.add(words.slice(i, i + 5).join(" "));
  return result;
}

// The part of the two sets that they have in common, from 0 to 1.
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const item of small) if (large.has(item)) common++;
  return common / (a.size + b.size - common);
}

function reason(error: unknown): string {
  if (error instanceof RobotsError) return "robots.txt disallows it";
  return error instanceof Error ? error.message : String(error);
}

// Download the pages of the selected chapters and their images, and write the EPUB file.
export async function fetchBook(options: FetchBookOptions): Promise<FetchBookResult> {
  const { toc, download } = options;
  const log = options.log ?? (() => {});
  const selected = options.chapters.map((number) => toc.chapters[number - 1]!);
  const total = selected.reduce((count, chapter) => count + chapter.pages.length, 0);
  const skipped: FetchBookResult["skipped"] = [];

  let pageNumber = 0;
  const kept: { url: string; words: number; shingles: Set<string> }[] = [];
  const chapters: { title: string; pages: { id: string; heading: string | null; page: CleanPage }[] }[] = [];
  for (const chapter of selected) {
    const pages: (typeof chapters)[number]["pages"] = [];
    for (const [i, page] of chapter.pages.entries()) {
      pageNumber++;
      log(`[${pageNumber}/${total}] ${chapter.title}${chapter.pages.length > 1 ? ` > ${page.title}` : ""}`);
      // The page of a chapter with one page, and the page of the chapter itself, need no heading of their own.
      const own = chapter.pages.length === 1 || (i === 0 && page.title.toLowerCase() === chapter.title.toLowerCase());
      const titles = chapter.pages.length === 1 ? [page.title, chapter.title] : [page.title];
      const layout = { prefix: `p${pageNumber}`, titles, headingBase: own ? 2 : 3 };
      try {
        const result = await download.get(page.url);
        if (result.status !== 200) throw new Error(`HTTP status ${result.status}`);
        const text = bodyText(result);
        const clean = isMarkdown(result.url, result.contentType)
          ? cleanMarkdownPage(text, result.url, layout)
          : cleanPage(text, result.url, layout);
        // Some sites show the same text under two addresses. Keep the first page.
        if (clean.words >= MIN_COMPARE_WORDS) {
          const pageShingles = shingles(clean.text);
          const same = kept.find(
            (other) => Math.abs(other.words - clean.words) <= clean.words * 0.2 && similarity(other.shingles, pageShingles) >= SAME_TEXT,
          );
          if (same) throw new Error(`the same text as ${same.url}`);
          kept.push({ url: page.url, words: clean.words, shingles: pageShingles });
        }
        pages.push({ id: layout.prefix, heading: own ? null : page.title, page: clean });
      } catch (error) {
        skipped.push({ url: page.url, reason: reason(error) });
        log(`  Skipped: ${reason(error)}`);
      }
    }
    if (pages.length > 0) chapters.push({ title: chapter.title, pages });
  }
  if (chapters.length === 0) throw new Error("No page of the selected chapters could be downloaded.");

  // Download each image one time. An image in a format that the parser cannot read keeps its address.
  const addresses = [...new Set(chapters.flatMap((chapter) => chapter.pages.flatMap((page) => page.page.images)))];
  const imageSrc = new Map<string, string>();
  const images: EpubImage[] = [];
  if (addresses.length > 0) log(`Images: ${addresses.length}`);
  for (const [i, address] of addresses.entries()) {
    if ((i + 1) % 10 === 0 || i + 1 === addresses.length) log(`  ${i + 1}/${addresses.length}`);
    try {
      const result = await download.get(address);
      if (result.status !== 200) throw new Error(`HTTP status ${result.status}`);
      if (result.body.length > MAX_IMAGE_BYTES) throw new Error("the file is larger than 10 MB");
      const type = IMAGE_TYPES.find((item) => item.test(result.body));
      if (!type) continue;
      const path = `images/${imageId(result.body)}.${type.extension}`;
      if (!images.some((image) => image.path === path)) images.push({ path, mediaType: type.mediaType, data: result.body });
      imageSrc.set(address, path);
    } catch (error) {
      skipped.push({ url: address, reason: reason(error) });
    }
  }

  const epubChapters: EpubChapter[] = chapters.map((chapter) => ({
    title: chapter.title,
    pages: chapter.pages.map((page) => ({ id: page.id, heading: page.heading, xhtml: page.page.render(imageSrc) })),
  }));
  const title = options.title ?? bookTitle(toc, options.chapters);
  const epub = await writeEpub({
    title,
    author: new URL(toc.startUrl).host,
    language: toc.language,
    source: toc.startUrl,
    date: options.date ?? new Date(),
    chapters: epubChapters,
    images,
  });
  return {
    title,
    epub,
    pages: chapters.reduce((count, chapter) => count + chapter.pages.length, 0),
    words: chapters.reduce((count, chapter) => count + chapter.pages.reduce((sum, page) => sum + page.page.words, 0), 0),
    images: images.length,
    skipped,
  };
}

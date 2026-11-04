import { basename, extname } from "node:path";
import { getDocument, ImageKind, OPS, PermissionFlag } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api.js";
import { flattenXhtml, type Block } from "../core/blocks.js";
import { encodePng, imageId, shrink, type Pixels } from "../core/png.js";
import type { BookImage, BookSource, TocEntry } from "../core/source.js";
import { classify } from "../core/structure.js";
import { countWords, normalizeSpace, sum } from "../core/text.js";
import { bookLayout, layoutToXhtml, markRunningLines, type BookLayout, type LayoutHeading, type PlacedImage } from "./layout.js";
import { pageToXhtml, plainText, type FontStyle, type OutlineAnchor, type PdfTextItem, type StructNode } from "./page.js";

// Read a PDF file. A tagged PDF has a structure tree with headings, paragraphs, lists, and tables, as HTML has. An
// untagged PDF has only text at positions on the page, so the layout reader finds its structure.

export const pageFile = (page: number) => `page-${String(page).padStart(4, "0")}`;

// A PDF with no text, for example a scanned book.
export class NoTextPdfError extends Error {
  override name = "NoTextPdfError";
}

// True if the permissions of a PDF allow the copy of its text. A PDF with no encryption has no permissions (null), so it
// allows all. pdf.js gives an array or a set of PermissionFlag values.
export function allowsCopy(permissions: Iterable<number> | null): boolean {
  return permissions === null || [...permissions].includes(PermissionFlag.COPY);
}

// The owner of the file can forbid the copy of its text. The user reads own files on own computer, so the reader
// reads the text and gives a warning (decided on 2026-11-04).
export const COPY_RESTRICTED_NOTE =
  "The permissions of this PDF file do not allow the copy of its text. The tutor reads the text for your own study. Do not share the text or the lessons.";

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

export interface OutlineEntry {
  title: string;
  page: number;
  top: number | null;
  children: OutlineEntry[];
}

const LABEL_ONLY = /^(chapter|part|appendix|section|unit|lesson|module|book)\s+[\w.-]+\s*[:.\-–—]?$/i;
const PAGE_NUMBER = /^\W*(\d{1,4}|[ivxlcdm]{1,7})\W*$/i;
const BOLD = /bold|black|heavy|semibold|demibold/i;
const ITALIC = /italic|oblique/i;
const MONO = /courier|consolas|mono|menlo|inconsolata|sourcecode|source code|firacode|lucidaconsole|andale|monaco/i;

async function resolveDestination(
  doc: PDFDocumentProxy,
  destination: string | unknown[],
): Promise<{ page: number; top: number | null } | null> {
  const explicit = typeof destination === "string" ? await doc.getDestination(destination) : destination;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  let index: number;
  try {
    const ref = explicit[0];
    index = typeof ref === "number" ? ref : await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
  } catch {
    return null;
  }
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const numberAt = (position: number) => (typeof explicit[position] === "number" ? (explicit[position] as number) : null);
  let top: number | null = null;
  if (kind === "XYZ") top = numberAt(3);
  else if (kind === "FitH" || kind === "FitBH") top = numberAt(2);
  else if (kind === "FitR") top = numberAt(5);
  return { page: index + 1, top };
}

// "CHAPTER 1:" and the name of the chapter are often two outline entries on one page. Join them.
export function joinLabels(entries: OutlineEntry[]): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const next = entries[i + 1];
    if (next && LABEL_ONLY.test(entry.title) && next.page === entry.page) {
      result.push({
        title: `${entry.title} ${next.title}`,
        page: entry.page,
        top: entry.top,
        children: [...entry.children, ...next.children],
      });
      i++;
    } else {
      result.push(entry);
    }
  }
  return result;
}

async function readOutline(doc: PDFDocumentProxy, nodes: OutlineNode[]): Promise<OutlineEntry[]> {
  const entries: OutlineEntry[] = [];
  for (const node of nodes) {
    const children = await readOutline(doc, node.items ?? []);
    const target = node.dest ? await resolveDestination(doc, node.dest) : null;
    const place = target ?? (children[0] ? { page: children[0].page, top: children[0].top } : null);
    if (!place) continue;
    entries.push({ title: normalizeSpace(node.title) || "Untitled", page: place.page, top: place.top, children });
  }
  return joinLabels(entries);
}

export interface FontInfo {
  name?: string;
  bold?: boolean;
  italic?: boolean;
  isMonospace?: boolean;
}

export function styleOfFont(font: FontInfo | undefined): FontStyle {
  // Remove the subset prefix, for example "YHTKRC+MinionPro-Regular".
  const name = (font?.name ?? "").replace(/^[A-Z]{6}\+/, "");
  return {
    bold: Boolean(font?.bold) || BOLD.test(name),
    italic: Boolean(font?.italic) || ITALIC.test(name) || /It$/.test(name),
    mono: name ? MONO.test(name) : Boolean(font?.isMonospace),
  };
}

function fontStyle(page: PDFPageProxy, fontName: string): FontStyle {
  try {
    return styleOfFont(page.commonObjs.get(fontName) as FontInfo | undefined);
  } catch {
    return styleOfFont(undefined);
  }
}

// With no fonts, each item has the regular style. The check of the text and the tags needs no fonts.
export async function readPageItems(page: PDFPageProxy, withFonts = true): Promise<PdfTextItem[]> {
  // The operator list loads the fonts, so that the font names are available.
  if (withFonts) await page.getOperatorList();
  const content = await page.getTextContent({ includeMarkedContent: true });
  const stack: { id: string | null; artifact: boolean }[] = [];
  const styles = new Map<string, FontStyle>();
  const items: PdfTextItem[] = [];
  for (const raw of content.items as (TextItem | (TextMarkedContent & { tag?: string }))[]) {
    if ("type" in raw) {
      if (raw.type === "beginMarkedContent" || raw.type === "beginMarkedContentProps") {
        stack.push({ id: raw.type === "beginMarkedContentProps" ? (raw.id ?? null) : null, artifact: raw.tag === "Artifact" });
      } else if (raw.type === "endMarkedContent") {
        stack.pop();
      }
      continue;
    }
    let style = styles.get(raw.fontName);
    if (!style) {
      style = fontStyle(page, raw.fontName);
      styles.set(raw.fontName, style);
    }
    const [a = 0, b = 0, , , x = 0, y = 0] = raw.transform as number[];
    items.push({
      str: raw.str,
      x,
      y,
      width: raw.width,
      height: raw.height,
      size: Math.hypot(a, b) || raw.height,
      font: style,
      mcid: [...stack].reverse().find((entry) => entry.id)?.id ?? null,
      artifact: stack.some((entry) => entry.artifact),
    });
  }
  return items;
}

// An image as pdf.js gives it after it decodes the image.
export interface PdfImage {
  width?: number;
  height?: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
}

// The pixels of a pdf.js image, or null for a format that the reader does not know.
export function pixelsOf(image: PdfImage): Pixels | null {
  const { width, height, kind, data } = image;
  if (!data || !width || !height) return null;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
  if (kind === ImageKind.RGB_24BPP) return { width, height, channels: 3, data: bytes };
  if (kind === ImageKind.RGBA_32BPP) return { width, height, channels: 4, data: bytes };
  if (kind === ImageKind.GRAYSCALE_1BPP) {
    // One bit for each pixel, and each row starts at a new byte. A set bit is white.
    const rowBytes = Math.ceil(width / 8);
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = (bytes[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { width, height, channels: 1, data: gray };
  }
  return null;
}

// The longest wait for the decoded data of one image.
const IMAGE_TIMEOUT_MS = 10_000;

// pdf.js sends the decoded data of an image after the operator list, so wait for it.
// pdf.js keeps an image that many pages use with the common objects. The id of such an image starts with "g_".
function imageObject(page: PDFPageProxy, id: string): Promise<PdfImage> {
  const objects = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), IMAGE_TIMEOUT_MS);
    objects.get(id, (data: unknown) => {
      clearTimeout(timer);
      resolve((data ?? {}) as PdfImage);
    });
  });
}

// The images that a page draws, by the marked content id around them. Each image becomes a PNG file in the images map.
// An image without a marked content id is decoration, so the reader ignores it.
export async function readPageImages(page: PDFPageProxy, images: Map<string, BookImage>): Promise<Map<number, string>> {
  const operators = await page.getOperatorList();
  const result = new Map<number, string>();
  const stack: (number | null)[] = [];
  for (const [i, fn] of operators.fnArray.entries()) {
    const args = (operators.argsArray[i] ?? []) as unknown[];
    if (fn === OPS.beginMarkedContentProps) stack.push(typeof args[1] === "number" ? args[1] : null);
    else if (fn === OPS.beginMarkedContent) stack.push(null);
    else if (fn === OPS.endMarkedContent) stack.pop();
    else if (fn === OPS.paintImageXObject) {
      const mcid = [...stack].reverse().find((id) => id !== null);
      if (mcid === undefined || mcid === null || result.has(mcid)) continue;
      const pixels = pixelsOf(await imageObject(page, String(args[0])));
      if (!pixels) continue;
      const data = encodePng(shrink(pixels));
      const id = imageId(data);
      images.set(id, { mediaType: "image/png", data });
      result.set(mcid, id);
    }
  }
  return result;
}

// An image smaller than this, in PDF units on each side, is decoration, for example an icon. 72 units are one inch.
const MIN_IMAGE_SIDE = 36;

// The images that a page with no tags draws, and the top of each image. The reader follows the transformation matrix
// of the page, because an image fills the unit square of the matrix. Each image becomes a PNG file in the images map.
export async function readPlacedImages(page: PDFPageProxy, images: Map<string, BookImage>): Promise<PlacedImage[]> {
  const operators = await page.getOperatorList();
  const result: PlacedImage[] = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  const saved: number[][] = [];
  // The matrix after a "cm" operator: the new transformation comes first, then the current matrix.
  const multiply = (m: number[], t: number[]) => [
    m[0]! * t[0]! + m[2]! * t[1]!,
    m[1]! * t[0]! + m[3]! * t[1]!,
    m[0]! * t[2]! + m[2]! * t[3]!,
    m[1]! * t[2]! + m[3]! * t[3]!,
    m[0]! * t[4]! + m[2]! * t[5]! + m[4]!,
    m[1]! * t[4]! + m[3]! * t[5]! + m[5]!,
  ];
  for (const [i, fn] of operators.fnArray.entries()) {
    const args = (operators.argsArray[i] ?? []) as unknown[];
    if (fn === OPS.save) saved.push(matrix);
    else if (fn === OPS.restore) matrix = saved.pop() ?? matrix;
    else if (fn === OPS.transform) matrix = multiply(matrix, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      saved.push(matrix);
      if (Array.isArray(args[0])) matrix = multiply(matrix, args[0] as number[]);
    } else if (fn === OPS.paintFormXObjectEnd) matrix = saved.pop() ?? matrix;
    else if (fn === OPS.paintImageXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => ({
        x: matrix[0]! * u! + matrix[2]! * v! + matrix[4]!,
        y: matrix[1]! * u! + matrix[3]! * v! + matrix[5]!,
      }));
      const xs = corners.map((corner) => corner.x);
      const ys = corners.map((corner) => corner.y);
      if (Math.max(...xs) - Math.min(...xs) < MIN_IMAGE_SIDE || Math.max(...ys) - Math.min(...ys) < MIN_IMAGE_SIDE) continue;
      const pixels = pixelsOf(await imageObject(page, String(args[0])));
      if (!pixels) continue;
      const data = encodePng(shrink(pixels));
      const id = imageId(data);
      images.set(id, { mediaType: "image/png", data });
      result.push({ id, top: Math.max(...ys) });
    }
  }
  return result;
}

// An image on many pages, for example a logo in the running head, is decoration. Remove it from the pages and the map.
function dropRepeatedImages(pages: PlacedImage[][], images: Map<string, BookImage>): void {
  const pagesOf = new Map<string, number>();
  for (const placed of pages) for (const id of new Set(placed.map((image) => image.id))) pagesOf.set(id, (pagesOf.get(id) ?? 0) + 1);
  for (const [id, count] of pagesOf) {
    if (count < 3) continue;
    images.delete(id);
    for (const placed of pages) placed.splice(0, placed.length, ...placed.filter((image) => image.id !== id));
  }
}

// Without bookmarks, the headings of the highest level that the book uses more than one time are the chapters. A level
// with one heading only is usually the title of the book.
export function tocFromHeadings(headings: { page: number; heading: LayoutHeading }[]): TocEntry[] {
  const counts = new Map<number, number>();
  for (const { heading } of headings) counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  const levels = [...counts].filter(([, count]) => count >= 2).map(([level]) => level);
  if (levels.length === 0) return [];
  const level = Math.min(...levels);
  return headings
    .filter(({ heading }) => heading.level === level)
    .map(({ page, heading }) => ({ title: heading.text, file: pageFile(page), anchor: heading.id, children: [] }));
}

// Give each Figure the images in its marked content. A content id ends with the marked content id, for example "p4912R_mc7".
export function attachImages(node: StructNode, images: Map<number, string>): void {
  const contentIds = (current: StructNode): string[] =>
    (current.children ?? []).flatMap((child) => ("role" in child ? contentIds(child) : child.type === "content" ? [child.id] : []));
  if (node.role === "Figure") {
    const ids = contentIds(node)
      .map((id) => images.get(Number(/_mc(\d+)$/.exec(id)?.[1] ?? NaN)))
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0) node.images = [...new Set(ids)];
  }
  for (const child of node.children ?? []) if ("role" in child) attachImages(child, images);
}

// Join a paragraph that continues on the next page: the first part has no end punctuation,
// and the second part starts with a lower case letter. A code block at the end of a page and a code block at the start
// of the next page also join.
export function joinAcrossPages(blocks: Block[]): Block[] {
  const result: Block[] = [];
  let last: Block | undefined;
  for (const block of blocks) {
    const isParagraph = (candidate: Block | undefined) =>
      candidate?.kind === "content" && candidate.html.startsWith("<p>") && candidate.html.endsWith("</p>");
    const isCode = (candidate: Block | undefined) =>
      candidate?.kind === "content" && candidate.html.startsWith("<pre><code>") && candidate.html.endsWith("</code></pre>");
    // A code block that continues on the next page.
    if (last && block.file !== last.file && isCode(block) && isCode(last) && block.anchors.length === 0) {
      last.html = `${last.html.slice(0, -"</code></pre>".length)}\n${block.html.slice("<pre><code>".length)}`;
      last.text = `${last.text}\n${block.text}`;
      last.words += block.words;
      last.pages.push(...block.pages);
      continue;
    }
    if (
      last &&
      block.file !== last.file &&
      isParagraph(block) &&
      isParagraph(last) &&
      block.anchors.length === 0 &&
      !/[.!?:;)"”’\]]$/.test(last.text) &&
      /^\p{Ll}/u.test(block.text)
    ) {
      last.html = `${last.html.slice(0, -"</p>".length)} ${block.html.slice("<p>".length)}`;
      last.text = `${last.text} ${block.text}`;
      last.words += block.words;
      last.pages.push(...block.pages);
      continue;
    }
    result.push(block);
    if (block.kind !== "pagebreak") last = block;
  }
  result.forEach((block, i) => {
    block.index = i;
  });
  return result;
}

// The text with the largest font on the first pages is usually the title of the book.
// Front matter titles, for example "Table of Contents", do not count.
function largestText(pages: PdfTextItem[][]): string {
  const groups: { size: number; text: string }[] = [];
  for (const items of pages) {
    const text = items.filter((item) => !item.artifact && item.str.trim() !== "");
    for (const size of new Set(text.map((item) => Math.round(item.size)))) {
      const words = text.filter((item) => Math.round(item.size) === size).map((item) => item.str);
      groups.push({ size, text: normalizeSpace(words.join(" ")) });
    }
  }
  groups.sort((a, b) => b.size - a.size);
  const title = groups.find(
    (group) => group.text.length >= 3 && group.text.length <= 150 && classify(group.text, []) === "chapter",
  );
  return title?.text ?? "";
}

export async function readPdf(data: Uint8Array, fileName: string): Promise<BookSource> {
  // pdf.js takes ownership of the buffer, so give it a copy.
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  try {
    const notes: string[] = [];
    if (!allowsCopy(await doc.getPermissions())) notes.push(COPY_RESTRICTED_NOTE);

    // The outline (bookmarks) gives the chapters and sections.
    const outline = await readOutline(doc, ((await doc.getOutline()) ?? []) as OutlineNode[]);
    const anchorsByPage = new Map<number, OutlineAnchor[]>();
    let counter = 0;
    const toToc = (entry: OutlineEntry): TocEntry => {
      const id = `outline-${++counter}`;
      anchorsByPage.set(entry.page, [...(anchorsByPage.get(entry.page) ?? []), { id, top: entry.top }]);
      return { title: entry.title, file: pageFile(entry.page), anchor: id, children: entry.children.map(toToc) };
    };
    const toc = outline.map(toToc);
    let tocSource: BookSource["tocSource"] = toc.length > 0 ? "outline" : "none";

    // Read the tags and the text of each page, with no fonts and no images. The fonts and the images come after the
    // check, because the decode of the images of a scanned book takes most of the time.
    const pages: { tree: StructNode | null; items: PdfTextItem[]; footerNumber: string | null }[] = [];
    let pagesWithText = 0;
    let pagesWithTags = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const items = await readPageItems(page, false);
      const tree = ((await page.getStructTree()) as StructNode | null) ?? null;
      const hasText = items.some((item) => !item.artifact && item.str.trim() !== "");
      if (hasText) pagesWithText++;
      if (hasText && tree && (tree.children ?? []).length > 0) pagesWithTags++;
      const footer = items.find((item) => item.artifact && PAGE_NUMBER.test(item.str.trim()));
      pages.push({ tree, items, footerNumber: footer ? PAGE_NUMBER.exec(footer.str.trim())![1]! : null });
      page.cleanup();
    }
    if (pagesWithText === 0) {
      throw new NoTextPdfError("The PDF has no text layer. It is probably a scanned book. The tutor cannot read it yet.");
    }
    // Most PDF files have tags on all pages or on no page. A file with tags on less than half of its pages with text
    // goes to the layout reader.
    const tagged = pagesWithTags >= pagesWithText / 2;

    // Read the text of each page again with its fonts, and the images of each page. In a tagged PDF, the figures of
    // the tags get their images. In an untagged PDF, each image keeps its place on the page.
    const images = new Map<string, BookImage>();
    const placed: PlacedImage[][] = pages.map(() => []);
    for (const [i, entry] of pages.entries()) {
      if (tagged && entry.items.length === 0 && !entry.tree) continue;
      const page = await doc.getPage(i + 1);
      if (entry.items.length > 0) entry.items = await readPageItems(page);
      if (tagged && entry.tree) {
        const pageImages = await readPageImages(page, images);
        if (pageImages.size > 0) attachImages(entry.tree, pageImages);
      }
      if (!tagged) placed[i] = await readPlacedImages(page, images);
      page.cleanup();
    }

    // The layout reader marks the running heads and the page numbers as artifacts, and finds the body and heading sizes.
    let layout: BookLayout | null = null;
    if (!tagged) {
      const numbers = markRunningLines(pages.map((page) => page.items));
      pages.forEach((page, i) => {
        page.footerNumber ??= numbers[i] ?? null;
      });
      dropRepeatedImages(placed, images);
      layout = bookLayout(pages.map((page) => page.items));
      notes.push(
        `The PDF has no structure tags on ${pagesWithText - pagesWithTags} of ${pagesWithText} pages with text. The reader used the layout of the pages.`,
      );
    }

    // The print page labels: the labels of the PDF, or the page numbers in the footers.
    const pdfLabels = await doc.getPageLabels();
    let labels = pages.map((page, i) => pdfLabels?.[i] || page.footerNumber);
    if (labels.every((label) => !label)) labels = pages.map((_, i) => String(i + 1));

    let blocks: Block[] = [];
    let untagged = 0;
    let sourceWords = 0;
    const lossyPages: string[] = [];
    const headings: { page: number; heading: LayoutHeading }[] = [];
    pages.forEach((page, i) => {
      const label = labels[i] ?? null;
      const anchors = anchorsByPage.get(i + 1) ?? [];
      let xhtml: string;
      if (layout) {
        const result = layoutToXhtml({ items: page.items, images: placed[i]!, label, anchors, layout });
        headings.push(...result.headings.map((heading) => ({ page: i + 1, heading })));
        xhtml = result.xhtml;
      } else {
        const result = pageToXhtml({ tree: page.tree, items: page.items, label, anchors });
        untagged += result.untaggedItems;
        xhtml = result.xhtml;
      }
      const pageBlocks = flattenXhtml(pageFile(i + 1), xhtml, blocks.length, new Map());
      blocks.push(...pageBlocks);

      // Compare the words of the page text with the words of the page blocks.
      const pageWords = countWords(plainText(page.items.filter((item) => !item.artifact)));
      const keptWords = sum(pageBlocks, (block) => block.words);
      sourceWords += pageWords;
      if (pageWords >= 30 && keptWords < pageWords * 0.9) lossyPages.push(`${i + 1} (${keptWords} of ${pageWords} words)`);
    });
    const keptWords = sum(blocks, (block) => block.words);
    blocks = joinAcrossPages(blocks);
    if (layout && toc.length === 0) {
      toc.push(...tocFromHeadings(headings));
      if (toc.length > 0) tocSource = "headings";
    }
    if (untagged > 0) {
      notes.push(`${untagged} text items have no structure tag. The reader put them at the end of their page.`);
    }
    if (lossyPages.length > 0) {
      notes.push(`The reader lost text on ${lossyPages.length} pages: ${lossyPages.slice(0, 10).join(", ")}${lossyPages.length > 10 ? ", ..." : ""}.`);
    }
    if (keptWords < sourceWords * 0.97) {
      notes.push(`The reader kept ${keptWords} of ${sourceWords} words of the PDF text.`);
    }

    const metadata = await doc.getMetadata();
    const info = (metadata.info ?? {}) as { Title?: string; Author?: string };
    const title =
      normalizeSpace(info.Title ?? "").replace(/^microsoft word - /i, "") ||
      largestText(pages.slice(0, 5).map((page) => page.items)) ||
      basename(fileName, extname(fileName));
    const authors = normalizeSpace(info.Author ?? "")
      .split(/\s*(?:,|;|&|\band\b)\s*/)
      .filter(Boolean);

    return {
      format: "pdf",
      title,
      authors,
      tocSource,
      toc,
      landmarks: [],
      blocks,
      images,
      notes,
    };
  } finally {
    await task.destroy();
  }
}

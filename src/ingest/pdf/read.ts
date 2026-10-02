import { basename, extname } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api.js";
import { flattenXhtml, type Block } from "../core/blocks.js";
import type { BookSource, TocEntry } from "../core/source.js";
import { classify } from "../core/structure.js";
import { countWords, normalizeSpace, sum } from "../core/text.js";
import { pageToXhtml, plainText, type FontStyle, type OutlineAnchor, type PdfTextItem, type StructNode } from "./page.js";

// Read a tagged PDF file. A tagged PDF has a structure tree with headings, paragraphs,
// lists, and tables, as HTML has. An untagged PDF has only text at positions on the page.

export const pageFile = (page: number) => `page-${String(page).padStart(4, "0")}`;

export class UntaggedPdfError extends Error {
  override name = "UntaggedPdfError";
}

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

export async function readPageItems(page: PDFPageProxy): Promise<PdfTextItem[]> {
  // The operator list loads the fonts, so that the font names are available.
  await page.getOperatorList();
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

// Join a paragraph that continues on the next page: the first part has no end punctuation,
// and the second part starts with a lower case letter.
export function joinAcrossPages(blocks: Block[]): Block[] {
  const result: Block[] = [];
  let last: Block | undefined;
  for (const block of blocks) {
    const isParagraph = (candidate: Block | undefined) =>
      candidate?.kind === "content" && candidate.html.startsWith("<p>") && candidate.html.endsWith("</p>");
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

    // Read the tags and the text of each page.
    const pages: { tree: StructNode | null; items: PdfTextItem[]; footerNumber: string | null }[] = [];
    let pagesWithText = 0;
    let pagesWithTags = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const items = await readPageItems(page);
      const tree = ((await page.getStructTree()) as StructNode | null) ?? null;
      const hasText = items.some((item) => !item.artifact && item.str.trim() !== "");
      if (hasText) pagesWithText++;
      if (hasText && tree && (tree.children ?? []).length > 0) pagesWithTags++;
      const footer = items.find((item) => item.artifact && PAGE_NUMBER.test(item.str.trim()));
      pages.push({ tree, items, footerNumber: footer ? PAGE_NUMBER.exec(footer.str.trim())![1]! : null });
      page.cleanup();
    }
    if (pagesWithText === 0) {
      throw new UntaggedPdfError("The PDF has no text layer. It is probably a scanned book. The tutor cannot read it yet.");
    }
    if (pagesWithTags < pagesWithText / 2) {
      throw new UntaggedPdfError(
        `The PDF has no structure tags on ${pagesWithText - pagesWithTags} of ${pagesWithText} pages with text. The tutor reads only tagged PDFs for now.`,
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
    pages.forEach((page, i) => {
      const result = pageToXhtml({
        tree: page.tree,
        items: page.items,
        label: labels[i] ?? null,
        anchors: anchorsByPage.get(i + 1) ?? [],
      });
      untagged += result.untaggedItems;
      const pageBlocks = flattenXhtml(pageFile(i + 1), result.xhtml, blocks.length, new Map());
      blocks.push(...pageBlocks);

      // Compare the words of the page text with the words of the page blocks.
      const pageWords = countWords(plainText(page.items.filter((item) => !item.artifact)));
      const keptWords = sum(pageBlocks, (block) => block.words);
      sourceWords += pageWords;
      if (pageWords >= 30 && keptWords < pageWords * 0.9) lossyPages.push(`${i + 1} (${keptWords} of ${pageWords} words)`);
    });
    const keptWords = sum(blocks, (block) => block.words);
    blocks = joinAcrossPages(blocks);
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
      tocSource: toc.length > 0 ? "outline" : "none",
      toc,
      landmarks: [],
      blocks,
      notes,
    };
  } finally {
    await task.destroy();
  }
}

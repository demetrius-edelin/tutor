// Read a PDF page that has no structure tags. Most PDF books have none, for example the books from LaTeX, from XSL-FO,
// and from calibre. The reader finds the structure in the layout of the text: the lines, the font sizes, the fonts, and
// the gaps. The reader of the tagged pages is in page.ts. Both readers give XHTML for the core.
import { IMAGE_SRC } from "../core/source.js";
import { escapeHtml, normalizeSpace } from "../core/text.js";
import { codeBlock, codeLines, inlineHtml, placeAnchors, stripBullet, type OutlineAnchor, type PdfTextItem } from "./page.js";

// An image of a page and the top of the image. The y axis goes up from the bottom of the page.
export interface PlacedImage {
  id: string;
  top: number;
}

// The fonts of the book.
export interface BookLayout {
  // The font size of most of the text.
  bodySize: number;
  // The smallest size of each group of heading sizes, from the largest group. A heading in group 0 has level 1.
  headingSizes: number[];
}

export interface LayoutInput {
  items: PdfTextItem[];
  images: PlacedImage[];
  // The print page label, or null.
  label: string | null;
  anchors: OutlineAnchor[];
  layout: BookLayout;
}

// A heading of the page. The id is the id of the anchor just before the heading.
export interface LayoutHeading {
  id: string;
  level: number;
  text: string;
}

export interface LayoutResult {
  xhtml: string;
  headings: LayoutHeading[];
}

// Larger text is a heading. A heading is at least this much larger than the body text.
const HEADING_RATIO = 1.15;
// Sizes in one group of heading sizes differ by less than this ratio, for example 21.0 and 21.2.
const SAME_SIZE = 0.96;
const GLYPH_BULLET = /^[•●◦▪■□‣⁃·∙○◆◇►▸➢✓✔]$/u;
const ATTACHED_BULLET = /^[•●◦▪■□‣⁃·∙○◆◇►▸➢✓✔]\s/u;
const SENTENCE_END = /[.!?:]["”’)\]]?$/;
// A chapter label above the title of the chapter, for example "CHAPTER 3" or "3".
const LABEL = /^((chapter|part|appendix|lesson|module)\s+[\w.-]+|\d{1,3})\s*[:.\-–—]?$/i;
const ROMAN = /^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

const visible = (items: PdfTextItem[]) => items.filter((item) => item.str.trim() !== "");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// A page number: digits or a roman number, with punctuation around it.
export function pageNumber(text: string): string | null {
  const core = text.replace(/^\W+|\W+$/g, "");
  return /^\d{1,4}$/.test(core) || ROMAN.test(core) ? core : null;
}

interface Line {
  // All the items, from left to right. Some PDF files put each space in an item of its own, so the text needs them.
  items: PdfTextItem[];
  // The items that are not spaces. The position, the size, and the font of the line come from them.
  visible: PdfTextItem[];
  // The baseline.
  y: number;
  x: number;
  right: number;
  // The largest and the smallest font size of the line.
  size: number;
  minSize: number;
}

function toLine(items: PdfTextItem[]): Line {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const text = visible(sorted);
  return {
    items: sorted,
    visible: text,
    y: text[0]!.y,
    x: text[0]!.x,
    right: Math.max(...text.map((item) => item.x + item.width)),
    size: Math.max(...text.map((item) => item.size)),
    minSize: Math.min(...text.map((item) => item.size)),
  };
}

// Group the items into lines, from the top of the page. Items on one baseline are one line. A line has at least one
// item that is not a space.
function groupLines(items: PdfTextItem[]): Line[] {
  const sorted = items.filter((item) => item.str !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PdfTextItem[][] = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    if (group && Math.abs(group[0]!.y - item.y) <= Math.min(group[0]!.size, item.size) * 0.5) group.push(item);
    else groups.push([item]);
  }
  return groups.filter((group) => visible(group).length > 0).map(toLine);
}

const isCode = (line: Line) => line.visible.every((item) => item.font.mono);
const isBold = (line: Line) => line.visible.every((item) => item.font.bold && !item.font.mono);
const textOf = (line: Line) => normalizeSpace(line.visible.map((item) => item.str).join(" "));

// The x position of the gap between two columns, or null for one column. Almost no text crosses the gap, and each
// column has at least a quarter of the text. Code does not count: the words of code lines can leave a gap by chance.
function columnGutter(items: PdfTextItem[]): number | null {
  const text = visible(items).filter((item) => !item.font.mono);
  if (text.length < 20) return null;
  const left = Math.min(...text.map((item) => item.x));
  const right = Math.max(...text.map((item) => item.x + item.width));
  const total = text.reduce((sum, item) => sum + item.str.length, 0);
  let best: { x: number; crossing: number } | null = null;
  for (let x = left + (right - left) * 0.3; x <= left + (right - left) * 0.7; x += 2) {
    let before = 0;
    let after = 0;
    let crossing = 0;
    for (const item of text) {
      if (item.x + item.width <= x) before += item.str.length;
      else if (item.x >= x) after += item.str.length;
      else crossing += item.str.length;
    }
    if (crossing <= total * 0.12 && before >= total * 0.25 && after >= total * 0.25 && (!best || crossing < best.crossing)) {
      best = { x, crossing };
    }
  }
  return best?.x ?? null;
}

// The lines in reading order. With two columns: the left column, then the right column. A line across both columns,
// for example a title, ends the columns above it.
function readingOrder(items: PdfTextItem[]): Line[] {
  const gutter = columnGutter(items);
  if (gutter === null) return groupLines(items);
  const wide: PdfTextItem[] = [];
  const left: PdfTextItem[] = [];
  const right: PdfTextItem[] = [];
  for (const item of items.filter((item) => item.str !== "")) {
    if (item.x + item.width <= gutter) left.push(item);
    else if (item.x >= gutter) right.push(item);
    else wide.push(item);
  }
  const leftLines = groupLines(left);
  const rightLines = groupLines(right);
  const result: Line[] = [];
  let l = 0;
  let r = 0;
  for (const line of [...groupLines(wide), null]) {
    const limit = line ? line.y : -Infinity;
    while (l < leftLines.length && leftLines[l]!.y > limit) result.push(leftLines[l++]!);
    while (r < rightLines.length && rightLines[r]!.y > limit) result.push(rightLines[r++]!);
    if (line) result.push(line);
  }
  return result;
}

// Running heads, running feet, and page numbers repeat at the same place on many pages. The reader marks them as
// artifacts, as a tagged PDF does. A running line has two conditions: many pages have a line at its place, and the
// lines at that place have page numbers or the same text. The result has the page number of each page, or null.
export function markRunningLines(pages: PdfTextItem[][]): (string | null)[] {
  interface Candidate {
    page: number;
    line: Line;
    // The text with each number as "#", so that "Chapter 2 | 14" and "Chapter 2 | 16" are the same.
    masked: string;
    number: string | null;
  }
  const candidates: Candidate[] = [];
  let textPages = 0;
  pages.forEach((items, page) => {
    const lines = groupLines(items.filter((item) => !item.artifact));
    if (lines.length === 0) return;
    textPages++;
    // The margin lines: one or two lines at the top and at the bottom of the page, with a large gap to the body text.
    // A line of the body text, for example a heading at the top of many pages, has no such gap.
    const margin = new Set<Line>();
    for (let n = 1; n <= 2 && n < lines.length; n++) {
      if (lines[n - 1]!.y - lines[n]!.y >= lines[n - 1]!.size * 1.5) {
        lines.slice(0, n).forEach((line) => margin.add(line));
        break;
      }
    }
    for (let n = 1; n <= 2 && n < lines.length; n++) {
      const end = lines.length - n;
      if (lines[end - 1]!.y - lines[end]!.y >= lines[end]!.size * 1.5) {
        lines.slice(end).forEach((line) => margin.add(line));
        break;
      }
    }
    for (const line of margin) {
      const parts = line.visible.map((item) => normalizeSpace(item.str));
      const text = parts.join(" ");
      // A running line is short, and it is not code. Code such as "}" can start many pages at the same place.
      if (text.length > 100 || isCode(line)) continue;
      const number = pageNumber(parts.at(-1)!) ?? pageNumber(parts[0]!);
      candidates.push({ page, line, masked: text.replace(/\d+/g, "#").toLowerCase(), number });
    }
  });

  // The candidates at the same height on the pages.
  const bands: Candidate[][] = [];
  for (const candidate of [...candidates].sort((a, b) => a.line.y - b.line.y)) {
    const band = bands.at(-1);
    if (band && candidate.line.y - band[0]!.line.y <= 3) band.push(candidate);
    else bands.push([candidate]);
  }

  const numbers: (string | null)[] = pages.map(() => null);
  const minPages = Math.max(3, Math.ceil(textPages * 0.25));
  for (const band of bands) {
    if (new Set(band.map((candidate) => candidate.page)).size < minPages) continue;
    const numbered = band.filter((candidate) => candidate.number !== null).length >= band.length * 0.5;
    const repeats = new Map<string, number>();
    for (const candidate of band) repeats.set(candidate.masked, (repeats.get(candidate.masked) ?? 0) + 1);
    for (const candidate of band) {
      const isNumber = numbered && candidate.number !== null;
      if (!isNumber && (repeats.get(candidate.masked)! < 3 || !/\p{L}/u.test(candidate.masked))) continue;
      for (const item of candidate.line.items) item.artifact = true;
      if (isNumber) numbers[candidate.page] = candidate.number;
    }
  }
  return numbers;
}

// The body size is the size of most of the text that is not code. The larger sizes are the headings.
export function bookLayout(pages: PdfTextItem[][]): BookLayout {
  const chars = new Map<number, number>();
  for (const items of pages) {
    for (const item of items) {
      if (item.artifact || item.font.mono || item.str.trim() === "") continue;
      const size = Math.round(item.size * 2) / 2;
      chars.set(size, (chars.get(size) ?? 0) + item.str.length);
    }
  }
  const bodySize = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const groups: number[][] = [];
  for (const size of [...chars.keys()].filter((size) => size >= bodySize * HEADING_RATIO).sort((a, b) => b - a)) {
    const group = groups.at(-1);
    if (group && size >= group.at(-1)! * SAME_SIZE) group.push(size);
    else groups.push([size]);
  }
  return { bodySize, headingSizes: groups.map((group) => group.at(-1)!) };
}

// The start of a list item: a bullet character, or a number such as "1." with a gap after it. The number of items
// before the text tells which items to leave out of the text.
function listStart(line: Line): { ordered: boolean; skip: number } | null {
  const [first, second] = line.visible;
  if (!first) return null;
  const head = first.str.trim();
  const gapAfter = second ? second.x - (first.x + first.width) > first.size * 0.3 : false;
  if (GLYPH_BULLET.test(head) && second) return { ordered: false, skip: 1 };
  if (ATTACHED_BULLET.test(first.str.trimStart())) return { ordered: false, skip: 0 };
  if (/^[-–—*]$/.test(head) && gapAfter) return { ordered: false, skip: 1 };
  if (/^\(?\d{1,2}[.)]$/.test(head) && gapAfter) return { ordered: true, skip: 1 };
  return null;
}

interface PageBlock {
  kind: "paragraph" | "code" | "heading" | "item" | "figure";
  lines: Line[];
  level: number;
  ordered: boolean;
  // The visible items at the start of the first line that are not text: a bullet or a number.
  skip: number;
  image: string | null;
  top: number | null;
  ids: string[];
}

const newBlock = (kind: PageBlock["kind"], line: Line, extra: Partial<PageBlock> = {}): PageBlock => ({
  kind,
  lines: [line],
  level: 0,
  ordered: false,
  skip: 0,
  image: null,
  top: line.y + line.size,
  ids: [],
  ...extra,
});

// Join the HTML of the lines of a paragraph. A word that the end of a line divides, for example "exam-" and "ple",
// becomes one word again.
function joinLines(parts: string[]): string {
  let html = "";
  for (const part of parts.filter(Boolean)) {
    if (!html) {
      html = part;
      continue;
    }
    const end = /(\p{L})-((?:<\/(?:strong|em|code)>)*)$/u.exec(html);
    if (end && /^(?:<(?:strong|em|code)>)*\p{Ll}/u.test(part)) html = html.slice(0, end.index + end[1]!.length) + end[2] + part;
    else html += ` ${part}`;
  }
  return html;
}

function levelOf(size: number, layout: BookLayout): number {
  const rounded = Math.round(size * 2) / 2;
  const group = layout.headingSizes.findIndex((smallest) => rounded >= smallest - 0.01);
  return Math.min(group === -1 ? layout.headingSizes.length + 1 : group + 1, 6);
}

export function layoutToXhtml(input: LayoutInput): LayoutResult {
  const { bodySize } = input.layout;
  const lines = readingOrder(input.items.filter((item) => !item.artifact));
  const textLines = lines.filter((line) => !isCode(line) && line.minSize < bodySize * HEADING_RATIO);
  // The usual distance between two lines of a paragraph on this page, and the right edge of the text.
  const gaps = textLines.slice(1).map((line, i) => textLines[i]!.y - line.y).filter((gap) => gap > 0 && gap < bodySize * 2.5);
  const leading = gaps.length > 0 ? median(gaps)! : bodySize * 1.2;
  const textRight = textLines.length > 0 ? Math.max(...textLines.map((line) => line.right)) : 0;

  const blocks: PageBlock[] = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    const previous = last?.lines.at(-1);
    // The distance from the line before. It is negative at the top of the next column.
    const gap = previous ? previous.y - line.y : Infinity;
    const newColumn = gap < -line.size;
    const previousText = previous ? textOf(previous) : "";

    if (line.minSize >= bodySize * HEADING_RATIO && !isCode(line)) {
      const level = levelOf(line.minSize, input.layout);
      if (last?.kind === "heading" && last.level === level && gap <= line.size * 1.6) last.lines.push(line);
      else blocks.push(newBlock("heading", line, { level }));
      continue;
    }

    // A line in a code font is code, except a line of inline code in the middle of a paragraph.
    const insideParagraph = last?.kind === "paragraph" && gap >= 0 && gap <= leading * 1.15 && !/:$/.test(previousText);
    if (isCode(line) && !insideParagraph) {
      if (last?.kind === "code" && (newColumn || (gap >= 0 && gap <= line.size * 3.5))) last.lines.push(line);
      else blocks.push(newBlock("code", line));
      continue;
    }

    const start = listStart(line);
    if (start) {
      blocks.push(newBlock("item", line, { ordered: start.ordered, skip: start.skip }));
      continue;
    }
    if (last?.kind === "item" && previous) {
      const textX = last.lines[0]!.visible[last.skip]?.x ?? last.lines[0]!.x;
      if (gap >= 0 && gap <= leading * 1.4 && line.x >= textX - line.size * 0.5) {
        last.lines.push(line);
        continue;
      }
    }
    if (last?.kind === "paragraph" && previous) {
      const ended = SENTENCE_END.test(previousText);
      const breaks =
        (newColumn ? ended : gap < 0 || gap > leading * 1.4 + 0.5) ||
        Math.abs(line.size - previous.size) > previous.size * 0.15 ||
        line.x > previous.x + line.size * 0.8 ||
        (ended && previous.right < textRight - line.size * 3) ||
        (isBold(previous) && !isBold(line) && !ended && previous.right < textRight - line.size * 3);
      if (!breaks) {
        last.lines.push(line);
        continue;
      }
    }
    blocks.push(newBlock("paragraph", line));
  }

  // A short line alone in bold, with no end punctuation, is a heading of the lowest level.
  for (const block of blocks) {
    const line = block.lines[0]!;
    if (block.kind === "paragraph" && block.lines.length === 1 && isBold(line) && !/[.,;:]$/.test(textOf(line)) && textOf(line).length <= 100) {
      block.kind = "heading";
      block.level = Math.min(input.layout.headingSizes.length + 1, 6);
    }
  }

  // Each image goes before the first block below its top.
  for (const image of [...input.images].sort((a, b) => b.top - a.top)) {
    const at = blocks.findIndex((block) => block.kind !== "figure" && block.top !== null && block.top <= image.top);
    const figure: PageBlock = { kind: "figure", lines: [], level: 0, ordered: false, skip: 0, image: image.id, top: image.top, ids: [] };
    if (at === -1) blocks.push(figure);
    else blocks.splice(at, 0, figure);
  }

  const unplaced = placeAnchors(blocks, input.anchors);
  // A bookmark often points to the title of a chapter, below its label. The bookmark moves to the label, so that the
  // label stays with its chapter and does not end the chapter before.
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    const before = blocks[i - 1]!;
    if (block.kind !== "heading" || before.kind !== "heading" || block.ids.length === 0 || before.ids.length > 0) continue;
    if (!LABEL.test(normalizeSpace(before.lines.map(textOf).join(" ")))) continue;
    before.ids.push(...block.ids);
    block.ids = [];
  }
  const anchor = (id: string) => `<span id="${escapeHtml(id)}"/>`;
  const parts: string[] = [];
  const headings: LayoutHeading[] = [];
  if (input.label) parts.push(`<span epub:type="pagebreak" title="${escapeHtml(input.label)}"/>`);
  parts.push(...unplaced.map((item) => anchor(item.id)));
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "item") {
      // Consecutive items of the same kind are one list.
      const items: PageBlock[] = [];
      while (blocks[i]?.kind === "item" && blocks[i]!.ordered === block.ordered) items.push(blocks[i++]!);
      i--;
      parts.push(...items.flatMap((item) => item.ids.map(anchor)));
      const entries = items.map((item) => {
        const marker = new Set(item.lines[0]!.visible.slice(0, item.skip));
        const html = joinLines(item.lines.map((line) => inlineHtml(line.items.filter((part) => !marker.has(part)))));
        return `<li>${item.skip === 0 ? stripBullet(html) : html}</li>`;
      });
      const tag = block.ordered ? "ol" : "ul";
      parts.push(`<${tag}>${entries.join("")}</${tag}>`);
      continue;
    }
    parts.push(...block.ids.map(anchor));
    if (block.kind === "figure") {
      parts.push(`<figure><img src="${IMAGE_SRC}${block.image}" alt=""/></figure>`);
    } else if (block.kind === "code") {
      parts.push(codeBlock(codeLines(block.lines.flatMap((line) => line.visible))));
    } else if (block.kind === "heading") {
      const text = normalizeSpace(block.lines.map(textOf).join(" "));
      const id = `heading-${headings.length + 1}`;
      headings.push({ id, level: block.level, text });
      parts.push(anchor(id), `<h${block.level}>${joinLines(block.lines.map((line) => inlineHtml(line.items, false)))}</h${block.level}>`);
    } else {
      const html = joinLines(block.lines.map((line) => inlineHtml(line.items)));
      if (html) parts.push(`<p>${html}</p>`);
    }
  }

  const xhtml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>` +
    parts.join("") +
    `</body></html>`;
  return { xhtml, headings };
}

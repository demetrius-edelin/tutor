import { posix } from "node:path";
import type { Block } from "./blocks.js";
import type { Landmark, TocEntry, Target } from "./source.js";
import type { ChapterKind, ParseWarning } from "./types.js";
import { sum } from "./text.js";

// A span is a range of blocks [start, end) that belongs to one chapter or one skipped part.
export interface Span {
  title: string;
  kind: ChapterKind;
  part: string | null;
  start: number;
  end: number;
}

export interface Locator {
  fileStart: Map<string, number>;
  anchorPos: Map<string, number>;
}

export function buildLocator(blocks: Block[]): Locator {
  const fileStart = new Map<string, number>();
  const anchorPos = new Map<string, number>();
  for (const block of blocks) {
    if (!fileStart.has(block.file)) fileStart.set(block.file, block.index);
    for (const id of block.anchors) {
      const key = `${block.file}#${id}`;
      if (!anchorPos.has(key)) anchorPos.set(key, block.index);
    }
  }
  return { fileStart, anchorPos };
}

export function locate(target: Target, locator: Locator): number | undefined {
  if (target.anchor) {
    const position = locator.anchorPos.get(`${target.file}#${target.anchor}`);
    if (position !== undefined) return position;
  }
  return locator.fileStart.get(target.file);
}

const PART_TITLE = /^part\s+([ivxlcdm]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const GLOSSARY_TITLE = /^glossary( of .*)?$/i;
const INDEX_TITLE = /^((general|subject) )?index$/i;
const APPENDIX_TITLE = /^appendix\b/i;
const FRONT_TITLE =
  /^((preface|foreword)\b.*|licen[cs]e|dedications?|acknowledge?ments?|about (the )?(authors?|this book|the cover.*)|copyright|title page|half title|cover|(table of )?contents?|contributors|praise for\b.*|also by\b.*|epigraph)$/i;
const BACK_TITLE =
  /^(references|further reading|colophon|endnotes|notes|about the authors?|other books( by .*)?)$|\bbibliography\b/i;

const FRONT_TYPES = new Set([
  "cover", "titlepage", "halftitlepage", "copyright-page", "dedication", "epigraph", "foreword",
  "preface", "acknowledgments", "toc", "frontmatter", "imprint", "contributors", "other-credits",
]);
const BACK_TYPES = new Set(["backmatter", "bibliography", "colophon", "endnotes", "rearnotes", "loi", "lot"]);

export function classify(title: string, types: string[]): ChapterKind {
  const all = new Set(types);
  if (GLOSSARY_TITLE.test(title) || all.has("glossary")) return "glossary";
  if (INDEX_TITLE.test(title) || all.has("index")) return "index";
  if (APPENDIX_TITLE.test(title) || all.has("appendix")) return "appendix";
  // Many EPUB tools mark each file as "chapter". Thus, a front or back matter title wins over the types.
  if (FRONT_TITLE.test(title)) return "front";
  if (BACK_TITLE.test(title)) return "back";
  if (all.has("chapter") || all.has("introduction") || all.has("bodymatter")) return "chapter";
  if ([...all].some((type) => FRONT_TYPES.has(type))) return "front";
  if ([...all].some((type) => BACK_TYPES.has(type))) return "back";
  return "chapter";
}

interface Start {
  title: string;
  part: string | null;
  start: number;
  partPage: boolean;
}

// Find the chapters in the table of contents. A part ("Part I") is not a chapter.
// Its children are the chapters, and its own pages become a separate span.
export function buildSpans(
  toc: TocEntry[],
  landmarks: Landmark[],
  blocks: Block[],
  locator: Locator,
  warnings: ParseWarning[],
  splitUnlisted = true,
): Span[] {
  if (blocks.length === 0) return [];
  const wordsBetween = (start: number, end: number) => sum(blocks.slice(start, end), (block) => block.words);

  const find = (entry: TocEntry) => {
    const position = locate(entry, locator);
    if (position === undefined) {
      warnings.push({
        code: "toc_target_missing",
        message: `The table of contents entry "${entry.title}" points to text that is not in the book.`,
      });
    }
    return position;
  };

  const isPart = (entry: TocEntry, start: number) => {
    if (entry.children.length === 0) return false;
    if (PART_TITLE.test(entry.title) || blocks[start]?.types.includes("part")) return true;
    const otherFiles = entry.children.filter((child) => child.file !== entry.file).length / entry.children.length;
    const firstChild = locate(entry.children[0]!, locator);
    const ownWords = firstChild === undefined ? 0 : wordsBetween(start, firstChild);
    return otherFiles >= 0.5 && ownWords < 150;
  };

  const starts: Start[] = [];
  for (const entry of toc) {
    const start = find(entry);
    if (start === undefined) continue;
    if (!isPart(entry, start)) {
      starts.push({ title: entry.title, part: null, start, partPage: false });
      continue;
    }
    starts.push({ title: entry.title, part: entry.title, start, partPage: true });
    for (const child of entry.children) {
      const childStart = find(child);
      if (childStart !== undefined) starts.push({ title: child.title, part: entry.title, start: childStart, partPage: false });
    }
  }

  if (starts.length === 0) {
    warnings.push({
      code: "no_toc",
      message: "The book has no usable table of contents. Each file of the book becomes one chapter.",
    });
    for (const [, start] of locator.fileStart) {
      const heading = blocks.slice(start).find((block) => block.kind === "heading" && block.file === blocks[start]!.file);
      starts.push({ title: heading?.text || blocks[start]!.file, part: null, start, partPage: false });
    }
  }

  const sorted = [...starts].sort((a, b) => a.start - b.start);
  if (sorted.some((start, i) => start !== starts[i])) {
    warnings.push({
      code: "toc_order",
      message: "The order of the table of contents is not the reading order. The parser uses the reading order.",
    });
  }
  const unique = sorted.filter((start, i) => i === 0 || start.start !== sorted[i - 1]!.start);

  const landmarkTypes = (position: number) => {
    const block = blocks[position]!;
    return landmarks
      .filter((landmark) => landmark.file === block.file && (!landmark.anchor || block.anchors.includes(landmark.anchor)))
      .flatMap((landmark) => landmark.type.split(/\s+/));
  };

  const spans: Span[] = [];
  if (unique[0]!.start > 0) {
    spans.push({ title: "Text before the table of contents", kind: "front", part: null, start: 0, end: unique[0]!.start });
  }
  unique.forEach((start, i) => {
    const end = unique[i + 1]?.start ?? blocks.length;
    let kind: ChapterKind;
    if (start.partPage) {
      kind = wordsBetween(start.start, end) < 150 ? "part" : "chapter";
    } else {
      kind = classify(start.title, [...blocks[start.start]!.types, ...landmarkTypes(start.start)]);
    }
    spans.push({ title: start.title, kind, part: start.part, start: start.start, end });
  });
  return splitUnlisted ? splitUnlistedFiles(spans, blocks, listedFiles(toc)) : spans;
}

function listedFiles(toc: TocEntry[]): Set<string> {
  const listed = new Set<string>();
  const visit = (entries: TocEntry[]) => {
    for (const entry of entries) {
      listed.add(entry.file);
      visit(entry.children);
    }
  };
  visit(toc);
  return listed;
}

// A file outside the table of contents continues the chapter before it.
// After front or back matter, for example an advertisement after the index, it becomes a separate part.
function splitUnlistedFiles(spans: Span[], blocks: Block[], listed: Set<string>): Span[] {
  if (listed.size === 0) return spans;
  const result: Span[] = [];
  for (const span of spans) {
    if (span.kind === "chapter" || span.kind === "appendix") {
      result.push(span);
      continue;
    }
    let current = span;
    for (let i = span.start + 1; i < span.end; i++) {
      const file = blocks[i]!.file;
      if (file === blocks[i - 1]!.file || listed.has(file)) continue;
      result.push({ ...current, end: i });
      const heading = blocks.slice(i, span.end).find((block) => block.file === file && block.kind === "heading");
      current = {
        title: heading?.text || posix.basename(file),
        kind: span.kind === "front" ? "front" : "back",
        part: null,
        start: i,
        end: span.end,
      };
    }
    result.push(current);
  }
  return result;
}

export function filesNotInToc(toc: TocEntry[], spans: Span[], blocks: Block[]): { file: string; span: Span }[] {
  const listed = listedFiles(toc);
  const result: { file: string; span: Span }[] = [];
  for (const span of spans) {
    if (span.kind !== "chapter" && span.kind !== "appendix") continue;
    const files = [...new Set(blocks.slice(span.start, span.end).map((block) => block.file))];
    for (const file of files) {
      const words = sum(blocks.slice(span.start, span.end).filter((block) => block.file === file), (block) => block.words);
      if (!listed.has(file) && words > 50) result.push({ file, span });
    }
  }
  return result;
}

export interface RawSection {
  title: string;
  blocks: Block[];
  sizeSplit: boolean;
  // The heading that starts the section. Blocks from a small section before it can come first.
  head?: Block;
}

export interface SplitOptions {
  maxWords: number;
  minWords: number;
}

export const SUMMARY_TITLE =
  /\b(summary|key takeaways|takeaways|recap|objectives|in this chapter|what you('ll| will) learn|chapter goals|key points|key concepts)\b/i;

const wordsOf = (blocks: Block[]) => sum(blocks, (block) => block.words);

const GENERIC_HEADING = /^(question|exercise|problem|example|case|lesson|step|tip|puzzle|quiz|q)\s*\.?\s*\d+[.:)]?$/i;

// True for a paragraph that is all bold, for example the question after the heading "Question 1".
function isBoldParagraph(block: Block): boolean {
  if (block.kind !== "content" || !/^<p[\s>]/.test(block.html) || !/<(strong|b)>/.test(block.html)) return false;
  const rest = block.html.replace(/<(strong|b)>[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, "");
  return rest.trim() === "";
}

// The title of a section that starts at a heading. A generic heading, for example "Question 1",
// takes the short bold paragraph or the heading after it: "Question 1: Difference between ...".
function headingTitle(block: Block, next: Block | undefined, fallback: string): string {
  const title = block.text || fallback;
  if (!GENERIC_HEADING.test(title) || !next || next.words === 0 || next.words > 30) return title;
  if (next.kind !== "heading" && !isBoldParagraph(next)) return title;
  return `${title.replace(/[.:)]$/, "")}: ${next.text}`;
}

function splitAt(blocks: Block[], isStart: (block: Block) => boolean, firstTitle: string): RawSection[] {
  const sections: RawSection[] = [{ title: firstTitle, blocks: [], sizeSplit: false }];
  blocks.forEach((block, i) => {
    if (isStart(block)) {
      const next = blocks.slice(i + 1).find((other) => other.kind !== "pagebreak");
      sections.push({ title: headingTitle(block, next, firstTitle), blocks: [block], sizeSplit: false, head: block });
    } else {
      sections.at(-1)!.blocks.push(block);
    }
  });
  return sections.filter((section) => section.blocks.length > 0);
}

// A small section joins the previous section. A small first section joins the next section.
// A summary section stays separate, because the checklist uses it.
function mergeSmall(sections: RawSection[], minWords: number): RawSection[] {
  const result: RawSection[] = [];
  let carry: Block[] = [];
  for (const section of sections) {
    const small = wordsOf(section.blocks) < minWords && !SUMMARY_TITLE.test(section.title);
    if (small && result.length > 0) {
      result.at(-1)!.blocks.push(...section.blocks);
    } else if (small) {
      carry.push(...section.blocks);
    } else {
      result.push({ ...section, blocks: [...carry, ...section.blocks] });
      carry = [];
    }
  }
  if (carry.length > 0) result.push({ title: sections[0]?.title ?? "", blocks: carry, sizeSplit: false });
  return result;
}

function splitBySize(section: RawSection, maxWords: number): RawSection[] {
  const parts: Block[][] = [[]];
  let count = 0;
  for (const block of section.blocks) {
    if (count > 0 && count + block.words > maxWords) {
      parts.push([]);
      count = 0;
    }
    parts.at(-1)!.push(block);
    count += block.words;
  }
  if (parts.length === 1) return [section];
  return parts.map((blocks, i) => ({
    title: i === 0 ? section.title : `${section.title} (part ${i + 1})`,
    blocks,
    sizeSplit: true,
    ...(i === 0 && section.head ? { head: section.head } : {}),
  }));
}

// Split a long section at its subheadings. If it has no subheadings, split it by size.
function refine(section: RawSection, options: SplitOptions): RawSection[] {
  if (wordsOf(section.blocks) <= options.maxWords) return [section];
  const headIndex = section.head ? section.blocks.indexOf(section.head) : -1;
  const subheadings = new Set(section.blocks.filter((block, i) => i > headIndex && block.kind === "heading"));
  if (subheadings.size > 0) {
    const level = Math.min(...[...subheadings].map((block) => block.level));
    const parts = mergeSmall(
      splitAt(section.blocks, (block) => subheadings.has(block) && block.level <= level, section.title),
      options.minWords,
    );
    if (parts.length > 1) return parts.flatMap((part) => refine(part, options));
  }
  return splitBySize(section, options.maxWords);
}

// Split a chapter into sections at its highest heading level under the chapter title.
export function splitChapter(title: string, blocks: Block[], options: SplitOptions): RawSection[] {
  // The first heading is the chapter title. A styled title can have more parts, for example
  // "Practice" and "No. 1". A heading before the first text is a part of the title
  // if each of its words is in the title from the table of contents.
  const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const titleWords = new Set(wordsOf(title));
  const titleHeadings = new Set<Block>();
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (titleHeadings.size > 0 && !wordsOf(block.text).every((word) => titleWords.has(word))) break;
      titleHeadings.add(block);
    } else if (block.words > 0) {
      break;
    }
  }
  const isSplit = (block: Block) => block.kind === "heading" && !titleHeadings.has(block);
  const levels = blocks.filter(isSplit).map((block) => block.level);
  if (levels.length === 0) return refine({ title, blocks, sizeSplit: false }, options);
  const level = Math.min(...levels);
  const sections = splitAt(blocks, (block) => isSplit(block) && block.level <= level, title);
  return mergeSmall(sections, options.minWords).flatMap((section) => refine(section, options));
}

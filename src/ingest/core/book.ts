import type { Block } from "./blocks.js";
import {
  containsTerm,
  dedupe,
  glossaryEntries,
  indexEntries,
  markedTerms,
  summaryItems,
} from "./checklist.js";
import { htmlToMarkdown } from "./markdown.js";
import { IMAGE_SRC, type BookImage, type BookSource } from "./source.js";
import {
  buildLocator,
  buildSpans,
  filesNotInToc,
  locate,
  splitChapter,
  SUMMARY_TITLE,
  type RawSection,
} from "./structure.js";
import { countWords, sum } from "./text.js";
import type {
  ChecklistItem,
  ChecklistSource,
  ParsedBook,
  ParsedChapter,
  ParsedSection,
  ParseWarning,
  SkippedPart,
} from "./types.js";

export interface ParseOptions {
  // A section with more words than this splits at its subheadings, or by size.
  maxSectionWords?: number;
  // A section with fewer words than this joins a neighbor section.
  minSectionWords?: number;
  // The text that the model read in each image, by image id. The text replaces the image in the Markdown.
  imageText?: ReadonlyMap<string, string>;
}

const SOURCE_ORDER: ChecklistSource[] = ["summary", "glossary", "index", "dfn", "bold", "emphasis"];
const SKIPPED_TEXT_WARNING = 300;
const LOST_TEXT_RATIO = 0.9;

// Turn the blocks and the table of contents of a book into chapters, sections, and a checklist.
export function buildBook(source: BookSource, options: ParseOptions = {}): ParsedBook {
  const split = { maxWords: options.maxSectionWords ?? 2500, minWords: options.minSectionWords ?? 40 };
  const warnings: ParseWarning[] = source.notes.map((message) => ({ code: "reader_note" as const, message }));
  const { blocks } = source;
  // In an EPUB, a file outside the table of contents is a problem to report.
  // In a PDF, each page is a file, so most files are outside the table of contents.
  const filesAreParts = source.format === "epub";

  const locator = buildLocator(blocks);
  const spans = buildSpans(source.toc, source.landmarks, blocks, locator, warnings, filesAreParts);

  // The print page at the start of each block.
  const pageAt: (string | null)[] = [];
  let page: string | null = null;
  for (const block of blocks) {
    pageAt.push(page);
    page = block.pages.at(-1) ?? page;
  }

  const chapters: ParsedChapter[] = [];
  const skipped: SkippedPart[] = [];
  const glossaryBlocks: Block[] = [];
  const indexBlocks: Block[] = [];
  const sectionOfAnchor = new Map<string, string>();
  const sectionOfBlock = new Map<number, string>();
  const sectionText = new Map<string, string>();

  for (const span of spans) {
    const spanBlocks = blocks.slice(span.start, span.end);
    const words = sum(spanBlocks, (block) => block.words);
    const files = [...new Set(spanBlocks.map((block) => block.file))];

    if (span.kind !== "chapter" && span.kind !== "appendix") {
      if (span.kind === "glossary") glossaryBlocks.push(...spanBlocks);
      if (span.kind === "index") indexBlocks.push(...spanBlocks);
      skipped.push({ title: span.title, kind: span.kind, words, files });
      const usedForChecklist = span.kind === "glossary" || span.kind === "index";
      if (!usedForChecklist && words >= SKIPPED_TEXT_WARNING) {
        warnings.push({
          code: "skipped_text",
          message: `"${span.title}" (${words} words) is ${span.kind} matter. Ingest does not teach it.`,
        });
      }
      continue;
    }

    const number = chapters.length + 1;
    const rawSections = splitChapter(span.title, spanBlocks, split);
    const sections = rawSections.map((raw, i) => toSection(number, i + 1, raw, pageAt, source.images, options.imageText));
    const checklist: ChecklistItem[] = [];

    rawSections.forEach((raw, i) => {
      const section = sections[i]!;
      for (const block of raw.blocks) {
        sectionOfBlock.set(block.index, section.id);
        for (const id of block.anchors) sectionOfAnchor.set(`${block.file}#${id}`, section.id);
        if (block.kind === "content") {
          for (const marked of markedTerms(block.html)) checklist.push({ ...marked, sectionId: section.id });
        }
      }
      if (SUMMARY_TITLE.test(raw.title)) {
        for (const item of summaryItems(raw.blocks.filter((block) => block.kind === "content").map((block) => block.html))) {
          checklist.push({ term: item, source: "summary", sectionId: section.id });
        }
      }
      sectionText.set(section.id, section.markdown.toLowerCase());

      if (section.words === 0) {
        warnings.push({ code: "empty_section", message: `Section ${section.id} "${section.title}" has no text.`, chapter: number });
      } else if (section.sourceWords >= 30 && section.words < section.sourceWords * LOST_TEXT_RATIO) {
        warnings.push({
          code: "lost_text",
          message: `Section ${section.id} "${section.title}" kept ${section.words} of ${section.sourceWords} words.`,
          chapter: number,
        });
      }
      if (raw.sizeSplit && raw.title.endsWith("(part 2)")) {
        warnings.push({
          code: "size_split",
          message: `Section "${raw.title.replace(/ \(part 2\)$/, "")}" has no subheadings, so the parser split it by size.`,
          chapter: number,
        });
      }
    });

    chapters.push({
      number,
      title: span.title,
      kind: span.kind,
      part: span.part,
      files,
      words: sum(sections, (section) => section.words),
      sourceWords: words,
      sections,
      checklist,
    });
  }

  for (const { file, span } of filesAreParts ? filesNotInToc(source.toc, spans, blocks) : []) {
    warnings.push({
      code: "not_in_toc",
      message: `The file "${file}" is not in the table of contents. Its text is part of "${span.title}".`,
    });
  }

  // Put each glossary and index term into the chapter that teaches it.
  const chapterOfSection = (sectionId: string) => chapters[Number(sectionId.split(".")[0]) - 1]!;
  const firstSectionWith = (term: string) => {
    const needle = term.replace(/ \(.*\)$/, "").toLowerCase();
    for (const [id, text] of sectionText) if (containsTerm(text, needle)) return id;
    return null;
  };
  const unassignedTerms: ChecklistItem[] = [];
  const assign = (item: ChecklistItem, sectionIds: (string | null)[]) => {
    const ids = [...new Set(sectionIds.filter((id): id is string => id !== null))].slice(0, 3);
    if (ids.length === 0) ids.push(...[firstSectionWith(item.term)].filter((id): id is string => id !== null));
    if (ids.length === 0) unassignedTerms.push(item);
    for (const id of ids) chapterOfSection(id).checklist.push({ ...item, sectionId: id });
  };

  const glossary = glossaryEntries(glossaryBlocks.filter((block) => block.kind === "content").map((block) => block.html));
  for (const entry of glossary) assign({ term: entry.term, source: "glossary", sectionId: null, detail: entry.definition }, []);

  const index = indexEntries(indexBlocks);
  for (const entry of index) {
    const ids = entry.targets.map((target) => {
      if (target.anchor) return sectionOfAnchor.get(`${target.file}#${target.anchor}`) ?? null;
      const position = locate(target, locator);
      return position === undefined ? null : (sectionOfBlock.get(position) ?? null);
    });
    assign({ term: entry.term, source: "index", sectionId: null }, ids);
  }
  if (unassignedTerms.length > 0) {
    warnings.push({
      code: "unassigned_terms",
      message: `${unassignedTerms.length} glossary or index terms are not in the text of any chapter.`,
    });
  }

  for (const chapter of chapters) {
    chapter.checklist.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
    chapter.checklist = dedupe(chapter.checklist, (item) => item.term);
  }

  // The images in the chapters. Images in front and back matter do not count.
  const images = new Map<string, BookImage>();
  for (const id of chapters.flatMap((chapter) => chapter.sections.flatMap((section) => section.images))) images.set(id, source.images.get(id)!);
  const unread = [...images.keys()].filter((id) => !options.imageText?.has(id)).length;
  if (unread > 0) {
    warnings.push({
      code: "unread_images",
      message: `${unread} images in the chapters have no text, so the sections keep only their alternative text. Ingest and refresh read these images with the model.`,
    });
  }

  return {
    format: source.format,
    title: source.title,
    authors: source.authors,
    tocSource: source.tocSource,
    chapters,
    skipped,
    glossaryEntries: glossary.length,
    indexEntries: index.length,
    unassignedTerms,
    warnings,
    images,
  };
}

const IMAGE_IDS = new RegExp(`<img\\b[^>]*\\bsrc="${IMAGE_SRC}([0-9a-f]+)"`, "g");

function toSection(
  chapter: number,
  number: number,
  raw: RawSection,
  pageAt: (string | null)[],
  images: ReadonlyMap<string, BookImage>,
  imageText: ReadonlyMap<string, string> | undefined,
): ParsedSection {
  const markdown = raw.blocks
    .map((block) => htmlToMarkdown(block.html, imageText))
    .filter(Boolean)
    .join("\n\n");
  const ids = raw.blocks.flatMap((block) => [...block.html.matchAll(IMAGE_IDS)].map((match) => match[1]!));
  const first = raw.blocks[0]!;
  return {
    id: `${chapter}.${number}`,
    number,
    title: raw.title,
    page: first.pages[0] ?? pageAt[first.index] ?? null,
    markdown,
    words: countWords(markdown),
    sourceWords: sum(raw.blocks, (block) => block.words),
    images: [...new Set(ids)].filter((id) => images.has(id)),
  };
}

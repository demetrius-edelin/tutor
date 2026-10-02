import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Db } from "../db/index.js";
import type { LlmClient } from "../llm/index.js";
import { slugify } from "./core/text.js";
import type { ParsedBook, ParseWarning } from "./core/types.js";
import { sectionFileName, writeParsedBook } from "./core/write.js";
import { emptyMap, loadMap, mapToMarkdown, saveMap, sourceDisplay, type ConceptMap } from "./map.js";
import { containsQuote } from "../llm/references.js";
import { chapterKey, digestChapter } from "./stages/digest.js";
import { mergeChapter } from "./stages/merge.js";
import type { ChapterDigest, ChapterInput } from "./stages/types.js";

export interface IngestOptions {
  llm: LlmClient;
  db: Db;
  dataDir: string;
  themeName: string;
  bookFile: string;
  book: ParsedBook;
  // Run only these chapters. Without save, the run is a preview that does not change the database.
  chapters?: number[];
  // Save the result of a run with chapters to the database.
  save?: boolean;
  // Remove the cached chapter results first.
  fresh?: boolean;
  // Replace the book if the theme has it already.
  replace?: boolean;
  log?: (line: string) => void;
}

export interface ChapterReport {
  number: number;
  title: string;
  sections: number;
  concepts: number;
  emptySections: { sectionId: string; title: string; reason: string }[];
  missingSections: { sectionId: string; title: string }[];
  minorItems: ChapterDigest["minorItems"];
  quoteWarnings: ChapterDigest["quoteWarnings"];
  skippedItems: number;
  added: number;
  joined: number;
}

export interface IngestReport {
  theme: string;
  book: string;
  preview: boolean;
  parseWarnings: ParseWarning[];
  chapters: ChapterReport[];
  modules: number;
  concepts: number;
  conceptMapFile: string;
  reportFile: string;
}

export function themeDir(dataDir: string, themeName: string): string {
  return join(dataDir, "themes", slugify(themeName));
}

export function bookDir(dataDir: string, themeName: string, book: ParsedBook): string {
  return join(themeDir(dataDir, themeName), "books", slugify(book.title));
}

// The chapters with a valid cached result. They need no model request.
export function cachedChapters(dataDir: string, themeName: string, book: ParsedBook): Set<number> {
  const workDir = join(bookDir(dataDir, themeName, book), "work");
  const cached = new Set<number>();
  for (const chapter of book.chapters) {
    const file = join(workDir, `chapter-${String(chapter.number).padStart(2, "0")}.json`);
    if (!existsSync(file)) continue;
    try {
      if ((JSON.parse(readFileSync(file, "utf8")) as ChapterDigest).key === chapterKey(chapterInput(chapter))) cached.add(chapter.number);
    } catch {
      // A broken cache file counts as no cache.
    }
  }
  return cached;
}

export function chapterInput(chapter: ParsedBook["chapters"][number]): ChapterInput {
  return {
    number: chapter.number,
    title: chapter.title,
    sections: chapter.sections.map((section) => ({
      id: section.id,
      title: section.title,
      markdown: section.markdown,
      words: section.words,
    })),
  };
}

// Remove the concepts that have no source and no progress, and the modules with no concept.
function removeOrphans(db: Db, themeId: number): void {
  db.prepare(
    "DELETE FROM concepts WHERE theme_id = ? AND status = 'new' AND id NOT IN (SELECT concept_id FROM concept_sources)",
  ).run(themeId);
  db.prepare("DELETE FROM modules WHERE theme_id = ? AND id NOT IN (SELECT module_id FROM concepts)").run(themeId);
}

// Check the quotes of a cached chapter again, with the current quote check. This needs no model request.
function recheckQuotes(digest: ChapterDigest, chapter: ChapterInput): ChapterDigest {
  const text = new Map(chapter.sections.map((section) => [section.id, section.markdown]));
  for (const concept of digest.concepts) {
    for (const source of concept.sources) source.quoteFound = containsQuote(text.get(source.sectionId) ?? "", source.quote);
  }
  digest.quoteWarnings = digest.concepts.flatMap((concept) =>
    concept.sources
      .filter((source) => !source.quoteFound)
      .map((source) => ({ concept: concept.name, sectionId: source.sectionId, quote: source.quote })),
  );
  return digest;
}

export async function ingestBook(options: IngestOptions): Promise<IngestReport> {
  const { llm, db, dataDir, themeName, book } = options;
  const log = options.log ?? (() => {});
  const preview = options.chapters !== undefined && !options.save;
  const themeSlug = slugify(themeName);
  const bookSlug = slugify(book.title);

  const theme = db.prepare("SELECT id FROM themes WHERE slug = ?").get(themeSlug) as { id: number } | undefined;
  const existing = theme
    ? (db.prepare("SELECT id FROM books WHERE theme_id = ? AND slug = ?").get(theme.id, bookSlug) as { id: number } | undefined)
    : undefined;
  if (existing && !preview && !options.replace) {
    throw new Error(`The theme "${themeName}" has the book "${book.title}" already. To ingest it again, add --replace.`);
  }

  // Keep a copy of the book file, the section files, and the parse report.
  const dir = bookDir(dataDir, themeName, book);
  mkdirSync(dir, { recursive: true });
  const bookCopy = join(dir, basename(options.bookFile));
  if (!existsSync(bookCopy)) copyFileSync(options.bookFile, bookCopy);
  writeParsedBook(book, dir);

  // Stages 2 and 3, one chapter at a time. A cached chapter result is used again.
  const workDir = join(dir, "work");
  if (options.fresh) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const chapters = book.chapters.filter((chapter) => !options.chapters || options.chapters.includes(chapter.number));
  const digests: ChapterDigest[] = [];
  for (const chapter of chapters) {
    const input = chapterInput(chapter);
    const cacheFile = join(workDir, `chapter-${String(chapter.number).padStart(2, "0")}.json`);
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as ChapterDigest;
      if (cached.key === chapterKey(input)) {
        log(`Chapter ${chapter.number}: ${chapter.title} (from the cache)`);
        digests.push(recheckQuotes(cached, input));
        continue;
      }
    }
    log(`Chapter ${chapter.number}: ${chapter.title}`);
    const digest = await digestChapter(llm, book.title, input, chapter.checklist, log);
    writeFileSync(cacheFile, `${JSON.stringify(digest, null, 2)}\n`);
    digests.push(digest);
  }

  // Stage 4: merge the chapters into the concept map, in the order of the book.
  const map: ConceptMap = theme ? loadMap(db, theme.id) : emptyMap();
  if (existing) {
    // The replaced book must not keep its old sources in the map.
    for (const concept of map.concepts) concept.sources = concept.sources.filter((source) => !source.key.startsWith(`${bookSlug}#`));
  }
  const sectionInfo = new Map(book.chapters.flatMap((chapter) => chapter.sections.map((section) => [section.id, section])));
  const stats = new Map<number, { added: number; joined: number }>();
  for (const digest of digests) {
    const chapter = book.chapters.find((item) => item.number === digest.chapter)!;
    log(`Merge chapter ${chapter.number}: ${digest.concepts.length} concepts`);
    stats.set(
      digest.chapter,
      await mergeChapter(llm, map, chapter.title, digest.concepts, (source) => {
        const section = sectionInfo.get(source.sectionId)!;
        return {
          key: `${bookSlug}#${source.sectionId}`,
          display: sourceDisplay(book.title, source.sectionId, section.title, section.page),
          quote: source.quote,
          quoteFound: source.quoteFound,
        };
      }),
    );
  }

  // A concept of a replaced book that the new run did not find again has no source now.
  map.concepts = map.concepts.filter((concept) => concept.sources.length > 0);

  // Save the book, its sections, and the map in one transaction. A preview saves nothing.
  if (!preview) {
    db.transaction(() => {
      const themeId =
        theme?.id ?? Number(db.prepare("INSERT INTO themes (slug, name) VALUES (?, ?)").run(themeSlug, themeName).lastInsertRowid);
      // Removing the book also removes its sections and the sources that point to them.
      if (existing) db.prepare("DELETE FROM books WHERE id = ?").run(existing.id);
      const bookId = Number(
        db
          .prepare("INSERT INTO books (theme_id, slug, title, file, status) VALUES (?, ?, ?, ?, 'ready')")
          .run(themeId, bookSlug, book.title, relative(dataDir, bookCopy)).lastInsertRowid,
      );
      const insertSection = db.prepare(
        "INSERT INTO sections (book_id, chapter, number, chapter_title, title, page, path, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const sectionRows = new Map<string, number>();
      for (const chapter of book.chapters) {
        for (const section of chapter.sections) {
          const path = relative(dataDir, join(dir, "sections", sectionFileName(chapter.number, section.number, section.title)));
          const row = insertSection.run(bookId, chapter.number, section.number, chapter.title, section.title, section.page, path, section.words);
          sectionRows.set(`${bookSlug}#${section.id}`, Number(row.lastInsertRowid));
        }
      }
      saveMap(db, themeId, map, sectionRows);
      removeOrphans(db, themeId);
    })();
  }

  // The ingest report and the concept map for people to read.
  const titleOf = (id: string) => sectionInfo.get(id)?.title ?? "";
  const chapterReports: ChapterReport[] = digests.map((digest) => {
    const chapter = book.chapters.find((item) => item.number === digest.chapter)!;
    return {
      number: chapter.number,
      title: chapter.title,
      sections: chapter.sections.length,
      concepts: digest.concepts.length,
      emptySections: digest.emptySections.map((item) => ({ ...item, title: titleOf(item.sectionId) })),
      missingSections: digest.missingSections.map((sectionId) => ({ sectionId, title: titleOf(sectionId) })),
      minorItems: digest.minorItems,
      quoteWarnings: digest.quoteWarnings,
      skippedItems: digest.skippedItems,
      ...(stats.get(digest.chapter) ?? { added: 0, joined: 0 }),
    };
  });
  const conceptMapFile = preview ? join(dir, "concept-map.preview.md") : join(themeDir(dataDir, themeName), "concept-map.md");
  writeFileSync(conceptMapFile, mapToMarkdown(preview ? `${themeName} (preview of ${book.title})` : themeName, map));
  const reportFile = join(dir, preview ? "ingest-report.preview.json" : "ingest-report.json");
  const report: IngestReport = {
    theme: themeName,
    book: book.title,
    preview,
    parseWarnings: book.warnings,
    chapters: chapterReports,
    modules: map.modules.filter((module) => map.concepts.some((concept) => concept.module === module.name)).length,
    concepts: map.concepts.length,
    conceptMapFile,
    reportFile,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

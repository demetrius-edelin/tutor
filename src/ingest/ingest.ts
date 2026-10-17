import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Db } from "../db/index.js";
import type { LlmClient } from "../llm/index.js";
import { selectSections } from "./core/book.js";
import { slugify } from "./core/text.js";
import type { ParsedBook, ParsedSection, ParseWarning } from "./core/types.js";
import { sectionFileName, writeParsedBook } from "./core/write.js";
import { emptyMap, loadMap, mapPreview, mapToMarkdown, saveMap, sectionPlace, sortMap, sourceDisplay, type ConceptMap } from "./map.js";
import { containsQuote } from "../llm/references.js";
import { chapterKey, digestChapter } from "./stages/digest.js";
import { mergeChapter } from "./stages/merge.js";
import type { ChapterDigest, ChapterInput } from "./stages/types.js";

export interface IngestOptions {
  llm: LlmClient;
  db: Db;
  dataDir: string;
  subjectName: string;
  bookFile: string;
  book: ParsedBook;
  // The folder name of the book in the subject. Without it, the name comes from bookSlugFor.
  bookSlug?: string;
  // Run only these chapters.
  chapters?: number[];
  // Run only these sections, for example "1.10". With chapters too, the run takes the sections of the two lists.
  // On a book that the subject has already, a run with some sections keeps the concepts of the other sections.
  sections?: string[];
  // A preview does not change the database. It writes the concept map and the report as preview files.
  preview?: boolean;
  // Remove the cached chapter results first.
  fresh?: boolean;
  // Replace the book if the subject has it already. A run with some sections replaces only the sources of these sections.
  replace?: boolean;
  // A problem with the images of the book, for the report.
  imageWarning?: string | null;
  log?: (line: string) => void;
  // Called before each model request of the extract, review, and merge stages. A chapter in the cache has no extract and review requests.
  progress?: (step: IngestStep) => void;
  // True if the user stopped the run. Then the run ends with IngestStopped before the next chapter, the next merge, or the save.
  stopped?: () => boolean;
}

// A model request of a run, for the progress display.
export interface IngestStep {
  stage: "extract" | "review" | "merge";
  // The place of the chapter in the run, from 0, and the number of chapters in the run.
  index: number;
  count: number;
  chapter: number;
  title: string;
  // The group of sections, from 1, and the number of groups in the chapter. A merge has one part.
  part: number;
  parts: number;
}

// The user stopped the run. The finished chapters stay in the cache. The database and the files of a saved book do not change.
export class IngestStopped extends Error {
  override name = "IngestStopped";
  constructor() {
    super("The run stopped.");
  }
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
  subject: string;
  book: string;
  preview: boolean;
  parseWarnings: ParseWarning[];
  imageWarning: string | null;
  chapters: ChapterReport[];
  modules: number;
  concepts: number;
  conceptMapFile: string;
  reportFile: string;
}

export function subjectDir(dataDir: string, subjectName: string): string {
  return join(dataDir, "subjects", slugify(subjectName));
}

export function bookDir(dataDir: string, subjectName: string, bookSlug: string): string {
  return join(subjectDir(dataDir, subjectName), "books", bookSlug);
}

// The file with the title of the book, in the folder of the book. A book that is not saved has its title only in this file.
const TITLE_FILE = "book.json";

export function writeBookTitle(dir: string, title: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TITLE_FILE), `${JSON.stringify({ title }, null, 2)}\n`);
}

// The title of the book in a folder, or null. A folder from an older version of the tutor has no title file,
// but it can have the parse report, with the title.
function folderTitle(dir: string): string | null {
  for (const name of [TITLE_FILE, "parse-report.json"]) {
    try {
      const { title } = JSON.parse(readFileSync(join(dir, name), "utf8")) as { title?: unknown };
      if (typeof title === "string") return title;
    } catch {
      // No file, or a broken file. Try the next file.
    }
  }
  return null;
}

// Two titles are the same book if they differ only in case, space, or punctuation, for example in the EPUB file and
// in the PDF file of a book. The characters "+" and "#" count, so "C++ Primer" and "C# Primer" are different books.
function titleKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]/gu, "");
}

// The folder name of a book in a subject, from the title. Two different books can have the same slug,
// for example "C++ Primer" and "C# Primer". Then the second book gets a number: "c-primer-2".
// A saved book keeps its slug. A folder with no title, from an older version, belongs to each title with its slug.
export function bookSlugFor(db: Db, dataDir: string, subjectName: string, title: string): string {
  const same = (other: string) => titleKey(other) === titleKey(title);
  const saved = db
    .prepare("SELECT b.slug, b.title FROM books b JOIN subjects s ON s.id = b.subject_id WHERE s.slug = ?")
    .all(slugify(subjectName)) as { slug: string; title: string }[];
  const own = saved.find((book) => same(book.title));
  if (own) return own.slug;
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (saved.some((book) => book.slug === slug)) continue;
    const other = folderTitle(bookDir(dataDir, subjectName, slug));
    if (other === null || same(other)) return slug;
  }
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

// The selected sections of each chapter. A chapter without a selected section is not in the list.
export function selectedInputs(book: ParsedBook, chapters?: number[], sections?: string[]): ChapterInput[] {
  const selected = selectSections(book, chapters, sections);
  return book.chapters
    .map((chapter) => chapterInput(chapter))
    .map((input) => ({ ...input, sections: input.sections.filter((section) => selected.has(section.id)) }))
    .filter((input) => input.sections.length > 0);
}

// The cache file of a chapter digest. A digest of some sections of a chapter has its own file, with a part of the key in the name.
function digestFile(workDir: string, book: ParsedBook, input: ChapterInput): string {
  const name = `chapter-${String(input.number).padStart(2, "0")}`;
  const full = book.chapters.find((chapter) => chapter.number === input.number)!.sections.length === input.sections.length;
  return join(workDir, full ? `${name}.json` : `${name}-${chapterKey(input).slice(0, 10)}.json`);
}

function cachedDigest(workDir: string, book: ParsedBook, input: ChapterInput): ChapterDigest | null {
  const file = digestFile(workDir, book, input);
  if (!existsSync(file)) return null;
  try {
    const digest = JSON.parse(readFileSync(file, "utf8")) as ChapterDigest;
    return digest.key === chapterKey(input) ? digest : null;
  } catch {
    // A broken cache file counts as no cache.
    return null;
  }
}

// The chapters with a valid cached result for their selected sections. They need no model request.
export function cachedChapters(dataDir: string, subjectName: string, bookSlug: string, book: ParsedBook, inputs: ChapterInput[]): Set<number> {
  const workDir = join(bookDir(dataDir, subjectName, bookSlug), "work");
  return new Set(inputs.filter((input) => cachedDigest(workDir, book, input)).map((input) => input.number));
}

// Remove the concepts that have no source and no history, and the modules with no concept.
// The status "new" is not enough: after "Later", a concept is "new" again, but it keeps its lessons, tests, answers, and star.
function removeOrphans(db: Db, subjectId: number): void {
  db.prepare(
    `DELETE FROM concepts WHERE subject_id = ? AND status = 'new' AND starred = 0
       AND id NOT IN (SELECT concept_id FROM concept_sources)
       AND id NOT IN (SELECT concept_id FROM lessons)
       AND id NOT IN (SELECT concept_id FROM questions)
       AND id NOT IN (SELECT concept_id FROM session_concepts)`,
  ).run(subjectId);
  db.prepare("DELETE FROM modules WHERE subject_id = ? AND id NOT IN (SELECT module_id FROM concepts)").run(subjectId);
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

// The database rows of the sections of a book that the subject has already, by section key.
// A run with some sections keeps these rows, so they must match the sections of the new parse.
function keptSections(
  db: Db,
  bookId: number,
  book: ParsedBook,
  bookSlug: string,
  sectionPath: (chapter: number, section: ParsedSection) => string,
): Map<string, number> {
  const rows = db.prepare("SELECT id, chapter, number, path FROM sections WHERE book_id = ?").all(bookId) as {
    id: number;
    chapter: number;
    number: number;
    path: string;
  }[];
  const byId = new Map(rows.map((row) => [`${row.chapter}.${row.number}`, row]));
  const sections = book.chapters.flatMap((chapter) => chapter.sections.map((section) => ({ chapter: chapter.number, section })));
  const match =
    rows.length === sections.length && sections.every(({ chapter, section }) => byId.get(section.id)?.path === sectionPath(chapter, section));
  if (!match) {
    throw new Error(`The sections of "${book.title}" in the database do not match the new parse. Ingest the full book again with --replace.`);
  }
  return new Map(rows.map((row) => [`${bookSlug}#${row.chapter}.${row.number}`, row.id]));
}

// The path of the file of a section, relative to the data folder.
function sectionPathIn(dataDir: string, dir: string) {
  return (chapter: number, section: ParsedSection) => relative(dataDir, join(dir, "sections", sectionFileName(chapter, section.number, section.title)));
}

// The problem if the subject has the book already and its sections do not match the parse. Then a run cannot keep them.
// The result is null if the sections match, or if the subject does not have the book.
export function sectionMismatch(db: Db, dataDir: string, subjectName: string, bookSlug: string, book: ParsedBook): string | null {
  const bookId = db
    .prepare("SELECT b.id FROM books b JOIN subjects s ON s.id = b.subject_id WHERE s.slug = ? AND b.slug = ?")
    .pluck()
    .get(slugify(subjectName), bookSlug) as number | undefined;
  if (bookId === undefined) return null;
  try {
    keptSections(db, bookId, book, bookSlug, sectionPathIn(dataDir, bookDir(dataDir, subjectName, bookSlug)));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function ingestBook(options: IngestOptions): Promise<IngestReport> {
  const { llm, db, dataDir, subjectName, book } = options;
  const log = options.log ?? (() => {});
  const preview = options.preview === true;
  const subjectSlug = slugify(subjectName);
  const bookSlug = options.bookSlug ?? bookSlugFor(db, dataDir, subjectName, book.title);

  const subject = db.prepare("SELECT id FROM subjects WHERE slug = ?").get(subjectSlug) as { id: number } | undefined;
  const existing = subject
    ? (db.prepare("SELECT id FROM books WHERE subject_id = ? AND slug = ?").get(subject.id, bookSlug) as { id: number } | undefined)
    : undefined;
  const dir = bookDir(dataDir, subjectName, bookSlug);
  const sectionPath = sectionPathIn(dataDir, dir);
  const sectionInfo = new Map(book.chapters.flatMap((chapter) => chapter.sections.map((section) => [section.id, section])));
  const inputs = selectedInputs(book, options.chapters, options.sections);
  const keys = new Set(inputs.flatMap((input) => input.sections.map((section) => `${bookSlug}#${section.id}`)));
  const partial = keys.size < sectionInfo.size;

  // A run on a book that the subject has already keeps the book and its sections, except a replace of the full book.
  // The old lessons and questions keep their references, and the other sections keep their concepts.
  const kept = existing && !preview && (partial || !options.replace) ? keptSections(db, existing.id, book, bookSlug, sectionPath) : null;
  if (existing && kept && !options.replace) {
    const used = new Set(
      db
        .prepare("SELECT DISTINCT section_id FROM concept_sources WHERE section_id IN (SELECT id FROM sections WHERE book_id = ?)")
        .pluck()
        .all(existing.id) as number[],
    );
    const again = [...keys].filter((key) => used.has(kept.get(key)!)).map((key) => key.slice(bookSlug.length + 1));
    if (again.length > 0) {
      const list = again.length > 5 ? `${again.slice(0, 5).join(", ")} and ${again.length - 5} more` : again.join(", ");
      throw new Error(`The sections ${list} of "${book.title}" have concepts already. To ingest them again, add --replace.`);
    }
  }

  // Keep a copy of the book file, the section files, and the parse report. Refresh parses the copy again.
  // The saved sections use these files. The files of a saved book change only in the save at the end.
  // Then a preview, a stop, or an error does not change them.
  const bookCopy = join(dir, basename(options.bookFile));
  const writeFiles = () => {
    // The book file of a run in the app is in the book folder already.
    if (resolve(options.bookFile) !== resolve(bookCopy)) copyFileSync(options.bookFile, bookCopy);
    writeParsedBook(book, dir);
  };
  mkdirSync(dir, { recursive: true });
  if (!existing) {
    writeBookTitle(dir, book.title);
    writeFiles();
  }

  // Stages 2 and 3, one chapter at a time. A cached chapter result is used again.
  // "fresh" removes only the cached chapter results. The cached image texts stay.
  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  if (options.fresh) {
    for (const file of readdirSync(workDir)) if (/^chapter-\d+(-[0-9a-f]+)?\.json$/.test(file)) rmSync(join(workDir, file));
  }
  const stopCheck = () => {
    if (options.stopped?.()) throw new IngestStopped();
  };
  const digests: ChapterDigest[] = [];
  for (const [index, input] of inputs.entries()) {
    const chapter = book.chapters.find((item) => item.number === input.number)!;
    stopCheck();
    const step = { index, count: inputs.length, chapter: chapter.number, title: chapter.title };
    const part = input.sections.length < chapter.sections.length ? `, sections ${input.sections.map((section) => section.id).join(", ")}` : "";
    const cached = cachedDigest(workDir, book, input);
    if (cached) {
      log(`Chapter ${chapter.number}: ${chapter.title}${part} (from the cache)`);
      digests.push(recheckQuotes(cached, input));
      continue;
    }
    log(`Chapter ${chapter.number}: ${chapter.title}${part}`);
    const digest = await digestChapter(llm, book.title, input, chapter.checklist, log, (stage, group, groups) =>
      options.progress?.({ ...step, stage, part: group, parts: groups }),
    );
    writeFileSync(digestFile(workDir, book, input), `${JSON.stringify(digest, null, 2)}\n`);
    digests.push(digest);
  }

  // Stage 4: merge the chapters into the concept map, in the order of the book.
  const map: ConceptMap = subject ? loadMap(db, subject.id) : emptyMap();
  if (existing) {
    // The replaced book must not keep its old sources in the map. A run with some sections replaces only the sources of these sections.
    const replaced = (key: string) => (partial ? keys.has(key) : key.startsWith(`${bookSlug}#`));
    for (const concept of map.concepts) concept.sources = concept.sources.filter((source) => !replaced(source.key));
  }
  // The place of the book in the book order. A book that the run saves as a new row comes after all books.
  const nextBookId = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 FROM books").pluck().get() as number);
  const bookId = existing && (kept || preview) ? existing.id : nextBookId;
  const stats = new Map<number, { added: number; joined: number }>();
  for (const [index, digest] of digests.entries()) {
    const chapter = book.chapters.find((item) => item.number === digest.chapter)!;
    stopCheck();
    options.progress?.({ stage: "merge", index, count: digests.length, chapter: chapter.number, title: chapter.title, part: 1, parts: 1 });
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
          place: sectionPlace(bookId, chapter.number, section.number),
        };
      }),
    );
  }

  // A concept of a replaced book that the new run did not find again has no source now.
  map.concepts = map.concepts.filter((concept) => concept.sources.length > 0);
  // The modules and the concepts follow the book order, also when the chapters come in a different order of runs.
  sortMap(map);

  // A stop during the last merge request ends the run here, before the save.
  stopCheck();

  // Save the book, its sections, and the map in one transaction. A preview saves nothing.
  if (!preview) {
    db.transaction(() => {
      const subjectId =
        subject?.id ?? Number(db.prepare("INSERT INTO subjects (slug, name) VALUES (?, ?)").run(subjectSlug, subjectName).lastInsertRowid);
      let sectionRows = kept;
      if (sectionRows) {
        // The book and its sections stay. Only the old sources of the selected sections go.
        const removeSources = db.prepare("DELETE FROM concept_sources WHERE section_id = ?");
        for (const key of keys) removeSources.run(sectionRows.get(key));
        // The section files come from the new book file, so refresh must parse the new file.
        db.prepare("UPDATE books SET file = ? WHERE id = ?").run(relative(dataDir, bookCopy), existing!.id);
      } else {
        // Removing the book also removes its sections and the sources that point to them.
        if (existing) db.prepare("DELETE FROM books WHERE id = ?").run(existing.id);
        const bookId = Number(
          db
            .prepare("INSERT INTO books (subject_id, slug, title, file, status) VALUES (?, ?, ?, ?, 'ready')")
            .run(subjectId, bookSlug, book.title, relative(dataDir, bookCopy)).lastInsertRowid,
        );
        const insertSection = db.prepare(
          "INSERT INTO sections (book_id, chapter, number, chapter_title, title, page, path, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        sectionRows = new Map<string, number>();
        for (const chapter of book.chapters) {
          for (const section of chapter.sections) {
            const path = sectionPath(chapter.number, section);
            const row = insertSection.run(bookId, chapter.number, section.number, chapter.title, section.title, section.page, path, section.words);
            sectionRows.set(`${bookSlug}#${section.id}`, Number(row.lastInsertRowid));
          }
        }
      }
      saveMap(db, subjectId, map, sectionRows);
      removeOrphans(db, subjectId);
      // The files change after the rows. If a row cannot change, the transaction stops and the files stay.
      if (existing) writeFiles();
    })();
  }

  // The ingest report and the concept map for people to read.
  const titleOf = (id: string) => sectionInfo.get(id)?.title ?? "";
  const chapterReports: ChapterReport[] = digests.map((digest) => {
    const chapter = book.chapters.find((item) => item.number === digest.chapter)!;
    return {
      number: chapter.number,
      title: chapter.title,
      sections: inputs.find((input) => input.number === digest.chapter)!.sections.length,
      concepts: digest.concepts.length,
      emptySections: digest.emptySections.map((item) => ({ ...item, title: titleOf(item.sectionId) })),
      missingSections: digest.missingSections.map((sectionId) => ({ sectionId, title: titleOf(sectionId) })),
      minorItems: digest.minorItems,
      quoteWarnings: digest.quoteWarnings,
      skippedItems: digest.skippedItems,
      ...(stats.get(digest.chapter) ?? { added: 0, joined: 0 }),
    };
  });
  const conceptMapFile = preview ? join(dir, "concept-map.preview.md") : join(subjectDir(dataDir, subjectName), "concept-map.md");
  writeFileSync(conceptMapFile, mapToMarkdown(preview ? `${subjectName} (preview of ${book.title})` : subjectName, map));
  // The app shows the preview concept map from data.
  if (preview) writeFileSync(join(dir, "concept-map.preview.json"), `${JSON.stringify(mapPreview(map, keys), null, 2)}\n`);
  const reportFile = join(dir, preview ? "ingest-report.preview.json" : "ingest-report.json");
  const report: IngestReport = {
    subject: subjectName,
    book: book.title,
    preview,
    parseWarnings: book.warnings,
    imageWarning: options.imageWarning ?? null,
    chapters: chapterReports,
    modules: map.modules.filter((module) => map.concepts.some((concept) => concept.module === module.name)).length,
    concepts: map.concepts.length,
    conceptMapFile,
    reportFile,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

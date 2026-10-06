import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Db } from "../db/index.js";
import type { LlmClient } from "../llm/index.js";
import { buildBook } from "./core/book.js";
import { slugify } from "./core/text.js";
import { sectionFileName, writeParsedBook } from "./core/write.js";
import { imageCacheFile, imagesToRead, readImages, type ImageReport } from "./images.js";
import { readBookSource } from "./parse.js";

// Refresh a book that the subject has already, for example after a change to the parser: parse it again,
// read the images that are not in the cache, and write the new section files.
// The model reads only the images of the chapters with concepts. Ingest reads the images of a chapter when it ingests the chapter.
// The ids of the sections stay, so the concepts, the progress, the lessons, and the test answers do not change.
// "ingest --replace" is different: it makes new sections, so the old lessons lose their references.

export interface RefreshOptions {
  llm: LlmClient;
  db: Db;
  dataDir: string;
  subjectName: string;
  // The folder name of the book, or its title.
  bookName: string;
  // Called before the model reads the images, with the number of images to read. Return false to stop.
  confirm?: (images: number) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface RefreshReport {
  subject: string;
  book: string;
  // The chapters with concepts. The model reads only the images of these chapters.
  chapters: number[];
  images: ImageReport;
  sections: number;
  // The ids of the sections with a new text, for example "2.5".
  changedSections: string[];
  // The concepts with a lesson that the tutor wrote from the old text of a changed section.
  oldLessons: string[];
}

// The result is null if the user stops before the model reads the images.
export async function refreshBook(options: RefreshOptions): Promise<RefreshReport | null> {
  const { db, dataDir, subjectName, bookName } = options;
  const log = options.log ?? (() => {});
  const subject = db.prepare("SELECT id, name FROM subjects WHERE slug = ?").get(slugify(subjectName)) as { id: number; name: string } | undefined;
  if (!subject) throw new Error(`The subject "${subjectName}" does not exist.`);
  const books = db.prepare("SELECT id, slug, title, file FROM books WHERE subject_id = ? ORDER BY id").all(subject.id) as {
    id: number;
    slug: string;
    title: string;
    file: string;
  }[];
  const row = books.find((book) => book.slug === slugify(bookName) || book.title.toLowerCase() === bookName.toLowerCase());
  if (!row) {
    throw new Error(`The subject "${subject.name}" has no book "${bookName}". Its books: ${books.map((book) => book.slug).join(", ") || "none"}.`);
  }
  const bookFile = join(dataDir, row.file);
  if (!existsSync(bookFile)) throw new Error(`The copy of the book is missing: ${bookFile}`);
  const dir = dirname(bookFile);

  log(`Parse "${row.title}"`);
  const source = await readBookSource(readFileSync(bookFile), bookFile);
  const cacheFile = imageCacheFile(dir);
  const chapters = db
    .prepare("SELECT DISTINCT s.chapter FROM concept_sources cs JOIN sections s ON s.id = cs.section_id WHERE s.book_id = ? ORDER BY s.chapter")
    .pluck()
    .all(row.id) as number[];
  const first = buildBook(source);
  const toRead = imagesToRead(first, cacheFile, chapters).length;
  if (toRead > 0 && options.confirm && !(await options.confirm(toRead))) return null;
  const images = await readImages(options.llm, first, cacheFile, { chapters, log });
  const book = buildBook(source, { imageText: images.text });

  // Each section of the new parse must have its row in the database, with the same file. Otherwise change nothing.
  const rows = db.prepare("SELECT id, chapter, number, path FROM sections WHERE book_id = ?").all(row.id) as {
    id: number;
    chapter: number;
    number: number;
    path: string;
  }[];
  const sections = book.chapters.flatMap((chapter) =>
    chapter.sections.map((section) => ({
      section,
      path: relative(dataDir, join(dir, "sections", sectionFileName(chapter.number, section.number, section.title))),
      row: rows.find((item) => item.chapter === chapter.number && item.number === section.number),
    })),
  );
  const problems: string[] = [];
  if (rows.length !== sections.length) problems.push(`The database has ${rows.length} sections, and the new parse has ${sections.length}.`);
  for (const { section, path, row: sectionRow } of sections) {
    if (!sectionRow) problems.push(`Section ${section.id} "${section.title}" is not in the database.`);
    else if (sectionRow.path !== path) problems.push(`Section ${section.id} has the file "${path}", but the database has "${sectionRow.path}".`);
  }
  if (problems.length > 0) {
    throw new Error(
      `The new parse of "${row.title}" does not match the database, so the command did not change the sections.\n` +
        problems.slice(0, 5).map((problem) => `- ${problem}`).join("\n"),
    );
  }

  const changed = sections.filter(({ section, path }) => {
    const file = join(dataDir, path);
    return !existsSync(file) || readFileSync(file, "utf8") !== `${section.markdown}\n`;
  });
  writeParsedBook(book, dir);
  const updateWords = db.prepare("UPDATE sections SET words = ? WHERE id = ?");
  db.transaction(() => {
    for (const { section, row: sectionRow } of sections) updateWords.run(section.words, sectionRow!.id);
  })();

  const changedIds = changed.map(({ row: sectionRow }) => sectionRow!.id);
  const oldLessons =
    changedIds.length === 0
      ? []
      : (db
          .prepare(
            `SELECT DISTINCT c.name FROM concepts c JOIN concept_sources cs ON cs.concept_id = c.id
             WHERE cs.section_id IN (${changedIds.map(() => "?").join(", ")}) AND EXISTS (SELECT 1 FROM lessons l WHERE l.concept_id = c.id)
             ORDER BY c.name`,
          )
          .pluck()
          .all(...changedIds) as string[]);
  return {
    subject: subject.name,
    book: row.title,
    chapters,
    images,
    sections: sections.length,
    changedSections: changed.map(({ section }) => section.id),
    oldLessons,
  };
}

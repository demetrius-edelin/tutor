import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./text.js";
import type { ParsedBook } from "./types.js";

const pad = (value: number) => String(value).padStart(2, "0");

export function sectionFileName(chapter: number, section: number, title: string): string {
  return `${pad(chapter)}-${pad(section)}-${slugify(title, 50)}.md`;
}

// Write each section to a Markdown file, and the parse report to parse-report.json.
// The function replaces the files of an earlier parse.
export function writeParsedBook(book: ParsedBook, outDir: string): { sectionsDir: string; reportFile: string } {
  const sectionsDir = join(outDir, "sections");
  rmSync(sectionsDir, { recursive: true, force: true });
  mkdirSync(sectionsDir, { recursive: true });

  const chapters = book.chapters.map((chapter) => ({
    ...chapter,
    sections: chapter.sections.map(({ markdown, ...section }) => {
      const path = join("sections", sectionFileName(chapter.number, section.number, section.title));
      writeFileSync(join(outDir, path), `${markdown}\n`);
      return { ...section, path };
    }),
  }));

  const report = {
    title: book.title,
    authors: book.authors,
    tocSource: book.tocSource,
    stats: {
      chapters: chapters.length,
      sections: chapters.reduce((total, chapter) => total + chapter.sections.length, 0),
      words: chapters.reduce((total, chapter) => total + chapter.words, 0),
      sourceWords: chapters.reduce((total, chapter) => total + chapter.sourceWords, 0),
      skippedWords: book.skipped.reduce((total, part) => total + part.words, 0),
      checklistItems: chapters.reduce((total, chapter) => total + chapter.checklist.length, 0),
      glossaryEntries: book.glossaryEntries,
      indexEntries: book.indexEntries,
    },
    warnings: book.warnings,
    skipped: book.skipped,
    chapters,
    unassignedTerms: book.unassignedTerms,
  };
  const reportFile = join(outDir, "parse-report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return { sectionsDir, reportFile };
}

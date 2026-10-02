import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../ingest/core/text.js";
import type { ChecklistSource } from "../ingest/core/types.js";
import { writeParsedBook } from "../ingest/core/write.js";
import { parseBook } from "../ingest/parse.js";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outArg = outFlag >= 0 ? args[outFlag + 1] : undefined;
const file = args.find((arg, i) => !arg.startsWith("--") && (outFlag < 0 || i !== outFlag + 1));
if (!file) {
  console.error("Usage: npm run parse -- <book.epub | book.pdf> [--out <folder>]");
  process.exit(1);
}

let book;
try {
  book = await parseBook(readFileSync(file), file);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const outDir = outArg ?? join("data", "parse", slugify(book.title));
const { reportFile } = writeParsedBook(book, outDir);

const n = (value: number) => value.toLocaleString("en-US");
const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`);

console.log(`\n${book.title}${book.authors.length ? ` (${book.authors.join(", ")})` : ""}`);
console.log(`Table of contents: ${book.tocSource}\n`);
console.log("  #  Kind      Sections    Words   Kept  Terms  Title");
for (const chapter of book.chapters) {
  console.log(
    `${String(chapter.number).padStart(3)}  ${chapter.kind.padEnd(8)}  ${String(chapter.sections.length).padStart(8)}  ${n(chapter.words).padStart(7)}  ${percent(chapter.words, chapter.sourceWords).padStart(5)}  ${String(chapter.checklist.length).padStart(5)}  ${chapter.title}`,
  );
}

const words = book.chapters.reduce((total, chapter) => total + chapter.words, 0);
const sections = book.chapters.reduce((total, chapter) => total + chapter.sections.length, 0);
console.log(`\nTotal: ${book.chapters.length} chapters, ${sections} sections, ${n(words)} words.`);

if (book.skipped.length > 0) {
  console.log("\nNot taught:");
  for (const part of book.skipped) console.log(`  ${part.kind.padEnd(9)} ${part.title} (${n(part.words)} words)`);
}

const bySource = new Map<ChecklistSource, number>();
for (const chapter of book.chapters) {
  for (const item of chapter.checklist) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
}
console.log(
  `\nChecklist: ${[...bySource].map(([source, count]) => `${source} ${count}`).join(", ") || "no items"}.` +
    ` Glossary entries: ${book.glossaryEntries}. Index entries: ${book.indexEntries}.`,
);

console.log(`\nWarnings: ${book.warnings.length}`);
for (const warning of book.warnings) console.log(`  [${warning.code}] ${warning.message}`);
console.log(`\nOutput: ${outDir}\nReport: ${reportFile}\n`);

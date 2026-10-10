import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ConfigError, loadEnvFile, modelConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { buildBook } from "../ingest/core/book.js";
import type { ParsedBook } from "../ingest/core/types.js";
import { cachedImageText, imageCacheFile, imagesToRead, readImages } from "../ingest/images.js";
import { bookDir, cachedChapters, ingestBook, selectedInputs, type IngestReport } from "../ingest/ingest.js";
import { readBookSource } from "../ingest/parse.js";
import { requestsFor } from "../ingest/stages/digest.js";
import { createClient, LlmError } from "../llm/index.js";
import { parseChapters } from "./chapters.js";

const USAGE = `Usage: npm run ingest -- <subject> <book.epub | book.pdf> [options]

Options:
  --chapters <list>  Ingest only these chapters, for example 1-3 or 2,5.
  --sections <list>  Ingest only these sections, for example 1.10 or 1.10-1.12,2.3.
                     The file 01-10-pointers.md in the sections folder is section 1.10.
  --preview          Do not change the database. Write the concept map to a preview file.
  --yes              Start without the question.
  --fresh            Ignore the cached chapter results.
  --replace          Replace the book if the subject has it already.`;

// A range of sections, for example 1.10-2.3, contains all the sections between the two sections, in the order of the book.
function parseSections(value: string, book: ParsedBook): string[] {
  const ids = book.chapters.flatMap((chapter) => chapter.sections.map((section) => section.id));
  const indexOf = (id: string) => {
    const index = ids.indexOf(id.trim());
    if (index < 0) throw new Error(`The book has no section "${id.trim()}". The file 01-10-pointers.md in the sections folder is section 1.10.`);
    return index;
  };
  const selected = new Set<string>();
  for (const part of value.split(",")) {
    const [start, end] = part.split("-");
    const first = indexOf(start!);
    const last = end === undefined ? first : indexOf(end);
    if (last < first) throw new Error(`"${part}" is not a valid section range.`);
    for (let i = first; i <= last; i++) selected.add(ids[i]!);
  }
  return [...selected];
}

function printReport(report: IngestReport): void {
  const n = (value: number) => value.toLocaleString("en-US");
  console.log(`\n${report.preview ? "Preview" : "Ingest"} of "${report.book}" in the subject "${report.subject}"\n`);
  console.log("  #  Sections  Concepts  Added  Joined  Empty  Minor  Quote warnings  Title");
  for (const chapter of report.chapters) {
    console.log(
      `${String(chapter.number).padStart(3)}  ${String(chapter.sections).padStart(8)}  ${String(chapter.concepts).padStart(8)}  ` +
        `${String(chapter.added).padStart(5)}  ${String(chapter.joined).padStart(6)}  ${String(chapter.emptySections.length).padStart(5)}  ` +
        `${String(chapter.minorItems.length).padStart(5)}  ${String(chapter.quoteWarnings.length).padStart(14)}  ${chapter.title}`,
    );
  }
  console.log(`\nConcept map: ${n(report.modules)} modules, ${n(report.concepts)} concepts.`);
  const missing = report.chapters.flatMap((chapter) => chapter.missingSections);
  if (missing.length > 0) console.log(`Sections without an answer from the model: ${missing.map((item) => item.sectionId).join(", ")}.`);
  console.log(`\nConcept map: ${report.conceptMapFile}\nReport: ${report.reportFile}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const valueOf = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const chaptersValue = valueOf("--chapters");
  const sectionsValue = valueOf("--sections");
  const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--chapters" && args[i - 1] !== "--sections");
  const [subjectName, bookFile] = positional;
  if (!subjectName || !bookFile) {
    console.error(USAGE);
    process.exit(1);
  }

  loadEnvFile();
  const config = modelConfig();
  // The sections get the image texts from the cache now. The model reads the other images after the question.
  const source = await readBookSource(readFileSync(bookFile), bookFile);
  const cacheFile = imageCacheFile(bookDir("data", subjectName, source));
  let book = buildBook(source, { imageText: cachedImageText(cacheFile) });
  const chapters = chaptersValue ? parseChapters(chaptersValue) : undefined;
  const sections = sectionsValue ? parseSections(sectionsValue, book) : undefined;
  const selected = selectedInputs(book, chapters, sections);
  if (selected.length === 0) throw new Error("No chapter matches the --chapters list.");

  // Cached chapters need no extract and review requests. Each chapter needs one merge request.
  const cached = flag("--fresh") ? new Set<number>() : cachedChapters("data", subjectName, book, selected);
  const images = imagesToRead(book, cacheFile, chapters, sections).length;
  const requests =
    selected.filter((input) => !cached.has(input.number)).reduce((total, input) => total + requestsFor(input), 0) + selected.length + images;
  const selectedSections = selected.flatMap((input) => input.sections);
  const words = selectedSections.reduce((total, section) => total + section.words, 0);
  console.log(`\nBook: ${book.title}`);
  console.log(`Subject: ${subjectName}`);
  console.log(`Model: ${config.provider} ${config.model}${config.reasoning ? `, reasoning ${config.reasoning}` : ""}`);
  const mode = flag("--preview") ? " (preview, the database does not change)" : " (saved to the database)";
  console.log(`Chapters: ${selected.length} of ${book.chapters.length}${mode}`);
  console.log(`Sections: ${selectedSections.length} of ${book.chapters.reduce((total, chapter) => total + chapter.sections.length, 0)}`);
  if (sections) for (const section of selectedSections) console.log(`  ${section.id}  ${section.title}`);
  console.log(`Text: ${words.toLocaleString("en-US")} words`);
  if (images > 0) console.log(`Images: ${images} to read with the model`);
  const cachedCount = selected.filter((chapter) => cached.has(chapter.number)).length;
  console.log(`Model requests: about ${requests}${cachedCount > 0 ? ` (${cachedCount} chapters come from the cache)` : ""}.\n`);

  if (!flag("--yes")) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Start? The requests cost money. [y/N] ");
    prompt.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Stopped.");
      return;
    }
  }

  const llm = createClient(config);
  if (images > 0) {
    const imageReport = await readImages(llm, book, cacheFile, {
      ...(chapters ? { chapters } : {}),
      ...(sections ? { sections } : {}),
      log: (line) => console.log(line),
    });
    if (imageReport.warning) console.log(`\n${imageReport.warning}\n`);
    book = buildBook(source, { imageText: imageReport.text });
  }

  const db = openDb("data/tutor.db");
  try {
    const report = await ingestBook({
      llm,
      db,
      dataDir: "data",
      subjectName,
      bookFile,
      book,
      ...(chapters ? { chapters } : {}),
      ...(sections ? { sections } : {}),
      preview: flag("--preview"),
      fresh: flag("--fresh"),
      replace: flag("--replace"),
      log: (line) => console.log(line),
    });
    printReport(report);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof LlmError || error instanceof Error) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

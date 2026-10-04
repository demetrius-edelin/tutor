import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ConfigError, loadEnvFile, modelConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { buildBook } from "../ingest/core/book.js";
import { cachedImageText, imageCacheFile, imagesToRead, readImages } from "../ingest/images.js";
import { bookDir, cachedChapters, chapterInput, ingestBook, type IngestReport } from "../ingest/ingest.js";
import { readBookSource } from "../ingest/parse.js";
import { requestsFor } from "../ingest/stages/digest.js";
import { createClient, LlmError } from "../llm/index.js";

const USAGE = `Usage: npm run ingest -- <theme> <book.epub | book.pdf> [options]

Options:
  --chapters <list>  Preview only these chapters, for example 1-3 or 2,5. A preview does not change the database.
  --save             Save the chapters of --chapters to the database.
  --yes              Start without the question.
  --fresh            Ignore the cached chapter results.
  --replace          Replace the book if the theme has it already.`;

function parseChapters(value: string): number[] {
  const numbers = new Set<number>();
  for (const part of value.split(",")) {
    const [start, end] = part.split("-").map((item) => Number(item.trim()));
    if (!start || Number.isNaN(start)) throw new Error(`"${value}" is not a valid chapter list.`);
    for (let n = start; n <= (end || start); n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

function printReport(report: IngestReport): void {
  const n = (value: number) => value.toLocaleString("en-US");
  console.log(`\n${report.preview ? "Preview" : "Ingest"} of "${report.book}" in the theme "${report.theme}"\n`);
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
  const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--chapters");
  const [themeName, bookFile] = positional;
  if (!themeName || !bookFile) {
    console.error(USAGE);
    process.exit(1);
  }

  loadEnvFile();
  const config = modelConfig();
  // The sections get the image texts from the cache now. The model reads the other images after the question.
  const source = await readBookSource(readFileSync(bookFile), bookFile);
  const cacheFile = imageCacheFile(bookDir("data", themeName, source));
  let book = buildBook(source, { imageText: cachedImageText(cacheFile) });
  const chapters = chaptersValue ? parseChapters(chaptersValue) : undefined;
  const selected = book.chapters.filter((chapter) => !chapters || chapters.includes(chapter.number));
  if (selected.length === 0) throw new Error("No chapter matches the --chapters list.");

  // Cached chapters need no extract and review requests. Each chapter needs one merge request.
  const cached = flag("--fresh") ? new Set<number>() : cachedChapters("data", themeName, book);
  const images = imagesToRead(book, cacheFile, chapters).length;
  const requests =
    selected.filter((chapter) => !cached.has(chapter.number)).reduce((total, chapter) => total + requestsFor(chapterInput(chapter)), 0) +
    selected.length +
    images;
  const words = selected.reduce((total, chapter) => total + chapter.words, 0);
  console.log(`\nBook: ${book.title}`);
  console.log(`Theme: ${themeName}`);
  console.log(`Model: ${config.provider} ${config.model}${config.reasoning ? `, reasoning ${config.reasoning}` : ""}`);
  const mode = !chapters ? "" : flag("--save") ? " (saved to the database)" : " (preview, the database does not change)";
  console.log(`Chapters: ${selected.length} of ${book.chapters.length}${mode}`);
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
    const imageReport = await readImages(llm, book, cacheFile, { ...(chapters ? { chapters } : {}), log: (line) => console.log(line) });
    if (imageReport.warning) console.log(`\n${imageReport.warning}\n`);
    book = buildBook(source, { imageText: imageReport.text });
  }

  const db = openDb("data/tutor.db");
  try {
    const report = await ingestBook({
      llm,
      db,
      dataDir: "data",
      themeName,
      bookFile,
      book,
      ...(chapters ? { chapters } : {}),
      save: flag("--save"),
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

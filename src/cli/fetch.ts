import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { describeModel, loadEnvFile, modelConfig } from "../config.js";
import { slugify } from "../ingest/core/text.js";
import { bookTitle, fetchBook } from "../ingest/web/fetch.js";
import { Downloader, httpFetcher } from "../ingest/web/http.js";
import { findToc } from "../ingest/web/toc.js";
import { createClient } from "../llm/index.js";
import { parseChapters } from "./chapters.js";

const USAGE = `Usage: npm run fetch -- <url> [options]

Download an online book or online documentation into an EPUB file in data/web/.
Then add the EPUB file to a subject with npm run ingest.

Options:
  --chapters <list>  Download only these chapters, for example 1-3 or 2,5.
  --toc <url>        Read the table of contents from the links of this page.
  --title <text>     The title of the book. The default is the title of the site.
  --yes              Download all the chapters without the question, and replace an old EPUB file.`;

const VALUE_FLAGS = ["--chapters", "--toc", "--title"];

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

function duration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const valueOf = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const positional = args.filter((arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1] ?? ""));
  const startUrl = positional[0];
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    console.error(USAGE);
    process.exit(1);
  }
  const tocUrl = valueOf("--toc");
  if (tocUrl !== undefined && !/^https?:\/\//i.test(tocUrl)) throw new Error(`"${tocUrl}" is not a web address.`);

  loadEnvFile();
  const download = new Downloader(httpFetcher);
  console.log(`\nStart page: ${startUrl}`);
  const toc = await findToc({
    startUrl,
    ...(tocUrl ? { tocUrl } : {}),
    download,
    llm: () => {
      const config = modelConfig();
      console.log(`Model: ${describeModel(config)}`);
      return createClient(config);
    },
    log: (line) => console.log(line),
  });

  console.log(`\nBook: ${toc.title}`);
  console.log(`Pages in: ${toc.scope}`);
  console.log("\n  #  Pages  Chapter");
  toc.chapters.forEach((chapter, i) => {
    console.log(`${String(i + 1).padStart(3)}  ${String(chapter.pages.length).padStart(5)}  ${chapter.title}`);
  });
  const allPages = toc.chapters.reduce((count, chapter) => count + chapter.pages.length, 0);
  console.log(`\nTotal: ${toc.chapters.length} chapters, ${allPages} pages.\n`);

  let answer = valueOf("--chapters");
  if (answer === undefined && !flag("--yes")) {
    answer = await ask("Chapters to download, for example 1-3,5 [all]: ");
  }
  const chapters = answer ? parseChapters(answer) : toc.chapters.map((_, i) => i + 1);
  const unknown = chapters.filter((number) => number > toc.chapters.length);
  if (unknown.length > 0) throw new Error(`The site has ${toc.chapters.length} chapters. There is no chapter ${unknown.join(", ")}.`);

  const title = valueOf("--title") ?? bookTitle(toc, chapters);
  const file = join("data", "web", `${slugify(title)}.epub`);
  if (existsSync(file) && !flag("--yes")) {
    if ((await ask(`The file ${file} exists. Replace it? [y/N] `)).toLowerCase() !== "y") {
      console.log("Stopped. To keep the two files, add --title with a different title.");
      return;
    }
  }

  const pages = chapters.reduce((count, number) => count + toc.chapters[number - 1]!.pages.length, 0);
  const seconds = (pages * download.pause) / 1000;
  console.log(`\nDownload: ${pages} pages, ${duration(seconds)}. Each image adds about one second.\n`);
  const result = await fetchBook({ toc, chapters, download, title, log: (line) => console.log(line) });

  mkdirSync(join("data", "web"), { recursive: true });
  writeFileSync(file, result.epub);

  console.log(`\nBook: ${result.title}`);
  console.log(`Pages: ${result.pages}. Words: ${result.words.toLocaleString("en-US")}. Images: ${result.images}.`);
  if (result.skipped.length > 0) {
    console.log(`\nNot downloaded: ${result.skipped.length}`);
    for (const item of result.skipped.slice(0, 20)) console.log(`  ${item.url} (${item.reason})`);
    if (result.skipped.length > 20) console.log(`  and ${result.skipped.length - 20} more`);
  }
  console.log(`\nEPUB file: ${file}`);
  console.log(`Check it: npm run parse -- ${file}`);
  console.log(`Add it to a subject: npm run ingest -- <subject> ${file}\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

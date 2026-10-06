import { createInterface } from "node:readline/promises";
import { ConfigError, loadEnvFile, modelConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { refreshBook } from "../ingest/refresh.js";
import { createClient, LlmError } from "../llm/index.js";

const USAGE = `Usage: npm run refresh -- <subject> <book> [--yes]

Parse a book of the subject again with the current parser, for example after an update of the tutor. The model reads
the images of the chapters with concepts that are not in the cache. The command writes only the section files and
the word counts of the sections. The concepts and your progress do not change.

<book> is the folder name of the book in data/subjects/<subject>/books/, or the title of the book.

Options:
  --yes  Start without the question.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [subjectName, bookName] = args.filter((arg) => !arg.startsWith("--"));
  if (!subjectName || !bookName) {
    console.error(USAGE);
    process.exit(1);
  }

  loadEnvFile();
  const config = modelConfig();
  const db = openDb("data/tutor.db");
  try {
    const report = await refreshBook({
      llm: createClient(config),
      db,
      dataDir: "data",
      subjectName,
      bookName,
      confirm: async (images) => {
        console.log(`\nModel: ${config.provider} ${config.model}${config.reasoning ? `, reasoning ${config.reasoning}` : ""}`);
        console.log(`Images: ${images} to read with the model, one request for each image.\n`);
        if (args.includes("--yes")) return true;
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question("Start? The requests cost money. [y/N] ");
        prompt.close();
        return answer.trim().toLowerCase() === "y";
      },
      log: (line) => console.log(line),
    });
    if (!report) {
      console.log("Stopped.");
      return;
    }
    const { images } = report;
    console.log(`\nRefresh of "${report.book}" in the subject "${report.subject}"\n`);
    const chapters = report.chapters.length > 0 ? report.chapters.join(", ") : "none";
    console.log(`Chapters with concepts: ${chapters}. The model reads only the images of these chapters.`);
    console.log(`Images: ${images.total} in these chapters, ${images.cached} from the cache, ${images.read} read now.`);
    if (images.warning) console.log(images.warning);
    console.log(`Sections: ${report.sections}, ${report.changedSections.length} with a new text.`);
    if (report.oldLessons.length > 0) {
      console.log(`\nThese concepts have a lesson from the old text. To get a lesson with the new text, open the lesson and click "Teach it again":`);
      for (const name of report.oldLessons) console.log(`  - ${name}`);
    }
    console.log("");
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

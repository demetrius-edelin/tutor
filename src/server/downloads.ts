import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Db } from "../db/index.js";
import { slugify } from "../ingest/core/text.js";
import { bookSlugFor } from "../ingest/ingest.js";
import { FetchStopped, type FetchProgress } from "../ingest/web/fetch.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { DownloadView, FetchStartView } from "./api-types.js";
import { storeBook } from "./books.js";
import { ingestRow, runningIngest, runText, toIngestView, type BookLocation } from "./ingests.js";

// A download in the app: a run with the mode "fetch" for an online book or for YouTube videos. The rule of one run
// at a time applies to it too. At the end, the download writes the EPUB file to data/web/ and keeps a copy in the
// folder of the book, as for an upload. A stopped download writes no EPUB file.

export interface DownloadPlan {
  // The title of the book. It gives the name of the EPUB file, as in the command.
  title: string;
  // The start address: an online book, or a YouTube video or playlist.
  source: string;
  // The selected chapters, or the selected videos of a playlist.
  chapters: number[];
  // The steps at the start: the pages, or the videos. The images of an online book add steps later.
  total: number;
  // Download the book. The result has the EPUB file and the result for the book page.
  download: (progress: (progress: FetchProgress) => void, stopped: () => boolean) => Promise<{ epub: Uint8Array; result: DownloadView }>;
}

export interface DownloadStart {
  db: Db;
  dataDir: string;
  subject: BookLocation["subject"];
  plan: DownloadPlan;
  // True to replace an EPUB file with the same title.
  again: unknown;
  // The ids of the runs that the user stopped.
  stops: Set<number>;
}

// Start a download. If data/web/ has an EPUB file with the same title, the download does not start, and the answer
// gives the file. With "again", the download replaces the file.
export function startDownload({ db, dataDir, subject, plan, again, stops }: DownloadStart): { view: FetchStartView; job: Promise<void> | null } {
  const file = join(dataDir, "web", `${slugify(plan.title)}.epub`);
  if (existsSync(file) && again !== true) return { view: { run: null, existing: { file: basename(file), title: plan.title } }, job: null };
  const running = runningIngest(db);
  if (running) throw new TutorError(`The tutor ${runText(running)} now. Only one run can work at a time.`, 409);

  const id = Number(
    db
      .prepare(
        "INSERT INTO ingests (subject_id, book, file, title, mode, chapters, status, total, source) VALUES (?, ?, ?, ?, 'fetch', ?, 'running', ?, ?)",
      )
      .run(subject.id, bookSlugFor(db, dataDir, subject.name, plan.title), relative(dataDir, file), plan.title, JSON.stringify(plan.chapters), plan.total, plan.source).lastInsertRowid,
  );
  return { view: { run: toIngestView(ingestRow(db, id)!, false), existing: null }, job: downloadJob(db, dataDir, subject, plan, id, file, stops) };
}

async function downloadJob(
  db: Db,
  dataDir: string,
  subject: BookLocation["subject"],
  plan: DownloadPlan,
  id: number,
  file: string,
  stops: Set<number>,
): Promise<void> {
  const progress = db.prepare("UPDATE ingests SET done = ?, total = ?, step = ? WHERE id = ?");
  try {
    const { epub, result } = await plan.download(
      ({ text, done, total }) => progress.run(done, total, text, id),
      () => stops.has(id),
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, epub);
    const { book } = await storeBook(db, dataDir, subject, basename(file), epub, id);
    db.prepare("UPDATE ingests SET status = 'done', done = total, step = '', book = ?, result = ? WHERE id = ?").run(book, JSON.stringify(result), id);
  } catch (error) {
    if (error instanceof FetchStopped) {
      db.prepare("UPDATE ingests SET status = 'stopped' WHERE id = ?").run(id);
    } else {
      db.prepare("UPDATE ingests SET status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : String(error), id);
    }
  } finally {
    stops.delete(id);
  }
}

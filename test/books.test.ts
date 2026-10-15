import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import type { LlmClient, ObjectRequest, TextRequest, TextResult } from "../src/llm/index.js";
import type { BookView, IngestView, SubjectDetail } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { buildEpub, mainFixture } from "./fixtures/epub.js";
import { FakeLlm } from "./fakes/llm.js";

// A model that can make each request wait, so that a test can act during a run.
class GatedLlm implements LlmClient {
  readonly inner = new FakeLlm();
  private gate: Promise<void> | null = null;
  private release = () => {};
  private arrive = () => {};
  // Resolves when a request waits at the closed gate.
  waiting: Promise<void> = Promise.resolve();

  close(): void {
    this.gate = new Promise((resolve) => (this.release = resolve));
    this.waiting = new Promise((resolve) => (this.arrive = resolve));
  }

  open(): void {
    this.gate = null;
    this.release();
  }

  async object<T>(request: ObjectRequest<T>): Promise<T> {
    if (this.gate) {
      this.arrive();
      await this.gate;
    }
    return this.inner.object(request);
  }

  async text(request: TextRequest): Promise<TextResult> {
    return this.inner.text(request);
  }
}

let epub: Uint8Array;
let db: Db;
let dataDir: string;
let app: TutorServer;

beforeAll(async () => {
  epub = await buildEpub(mainFixture());
});

afterEach(async () => {
  await app.close();
});

function start(llm: LlmClient | null) {
  dataDir = mkdtempSync(join(tmpdir(), "tutor-books-"));
  db = openDb(":memory:");
  app = buildServer({ db, dataDir, llm, ...(llm ? { modelName: "fake model" } : { llmError: "No model is selected." }) });
}

const get = async <T>(url: string) => {
  const response = await app.inject({ method: "GET", url });
  return { status: response.statusCode, body: response.json() as T };
};

const post = async <T>(url: string, payload: object = {}) => {
  const response = await app.inject({ method: "POST", url, payload });
  return { status: response.statusCode, body: response.json() as T };
};

const upload = async (subject: string, name: string, data: Uint8Array) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/subjects/${subject}/books?name=${encodeURIComponent(name)}`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from(data),
  });
  return { status: response.statusCode, body: response.json() as { book: string; error?: string } };
};

const run = (mode: string, chapters: number[]) => post<IngestView & { error?: string }>("/api/subjects/git/books/fixture-book/ingest", { mode, chapters });
const book = async () => (await get<BookView>("/api/subjects/git/books/fixture-book")).body;
const extractedSections = (llm: FakeLlm) =>
  llm.calls.filter((call) => call.stage === "extract").flatMap((call) => call.request.sources!.map((source) => source.id));

describe("Create a subject", () => {
  it("creates an empty subject, and refuses an empty name or a name that exists", async () => {
    start(new FakeLlm());
    expect(await post("/api/subjects", { name: "  Git   basics " })).toEqual({ status: 200, body: { slug: "git-basics", name: "Git basics" } });
    expect((await post("/api/subjects", { name: "git basics" })).status).toBe(409);
    expect((await post("/api/subjects", { name: " " })).status).toBe(400);
    expect((await post("/api/subjects", { name: "日本語" })).status).toBe(400);
    const { body } = await get<SubjectDetail>("/api/subjects/git-basics");
    expect(body).toMatchObject({ name: "Git basics", books: 0, bookList: [], ingest: null, unsavedBooks: [] });
  });
});

describe("Upload a book", () => {
  it("keeps the file in the folder of the book, and shows the plan of the book", async () => {
    start(new FakeLlm());
    await post("/api/subjects", { name: "Git" });
    expect(await upload("git", "../books/fixture.epub", epub)).toEqual({ status: 200, body: { book: "fixture-book" } });
    expect(existsSync(join(dataDir, "subjects", "git", "books", "fixture-book", "fixture.epub"))).toBe(true);

    const view = await book();
    expect(view).toMatchObject({ title: "Fixture Book", format: "epub", saved: false, model: "fake model", problem: null, run: null, report: null });
    expect(view.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3, 4, 5]);
    for (const chapter of view.chapters) {
      expect(chapter).toMatchObject({ cached: false, hasConcepts: false, images: 0 });
      // One extract request and one review request for each group of sections, and one merge request.
      expect(chapter.requests).toBeGreaterThanOrEqual(3);
    }
  });

  it("refuses a file that is not a book, and accepts a file larger than the default limit of 1 MB", async () => {
    start(new FakeLlm());
    await post("/api/subjects", { name: "Git" });
    expect((await upload("git", "notes.txt", epub)).status).toBe(400);
    expect((await upload("git", "broken.epub", new TextEncoder().encode("not a zip file"))).status).toBe(400);
    expect((await upload("none", "fixture.epub", epub)).status).toBe(404);

    // A data file that the reader does not parse makes the EPUB file large.
    const large = mainFixture();
    large.files["large.bin"] = new Uint8Array(1_500_000);
    expect((await upload("git", "large.epub", await buildEpub(large))).status).toBe(200);
  });

  it("shows the model problem, and no model name, if .env selects no model", async () => {
    start(null);
    await post("/api/subjects", { name: "Git" });
    await upload("git", "fixture.epub", epub);
    expect(await book()).toMatchObject({ model: null, modelError: "No model is selected." });
    expect((await run("preview", [1])).status).toBe(503);
  });
});

describe("Ingest in the app", () => {
  it("previews some chapters, then saves them with only the merge requests", async () => {
    const llm = new FakeLlm();
    start(llm);
    await post("/api/subjects", { name: "Git" });
    await upload("git", "fixture.epub", epub);

    const preview = await run("preview", [1]);
    expect(preview.body).toMatchObject({ mode: "preview", chapters: [1], status: "running" });
    await app.idle();
    const done = (await get<IngestView>(`/api/ingests/${preview.body.id}`)).body;
    // One extract request, one review request, and one merge request.
    expect(done).toMatchObject({ status: "done", done: 3, total: 3, error: null });

    let view = await book();
    expect(view.run).toMatchObject({ mode: "preview", status: "done" });
    expect(view.report).toMatchObject({ preview: true, chapters: [{ number: 1 }] });
    const previewMap = view.report!.conceptMap!;
    expect(previewMap.map((module) => [module.position, module.name])).toEqual([[1, "Basics"]]);
    expect(previewMap[0]!.concepts[1]).toMatchObject({
      level: "basic",
      kind: "knowledge",
      sources: [{ text: "Fixture Book, 1.2 First Section, p. 5", quoteFound: true }],
      needs: [previewMap[0]!.concepts[0]!.name],
      onMap: false,
    });
    expect(view.chapters[0]).toMatchObject({ cached: true, requests: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM concepts").pluck().get()).toBe(0);
    expect((await get<SubjectDetail>("/api/subjects/git")).body.unsavedBooks).toEqual([{ slug: "fixture-book", title: "Fixture Book" }]);

    const extracts = llm.count("extract");
    const merges = llm.count("merge");
    await run("save", [1]);
    await app.idle();
    expect(llm.count("extract")).toBe(extracts);
    expect(llm.count("merge")).toBe(merges + 1);

    view = await book();
    expect(view).toMatchObject({ saved: true, problem: null, report: { preview: false, conceptMap: null } });
    expect(view.chapters.map((chapter) => chapter.hasConcepts)).toEqual([true, false, false, false, false]);
    const subject = (await get<SubjectDetail>("/api/subjects/git")).body;
    expect(subject).toMatchObject({ books: 1, unsavedBooks: [], ingest: null });
    expect(subject.bookList[0]).toMatchObject({ chapters: 5, chaptersWithConcepts: 1 });

    // A chapter with concepts needs the command with --replace. A new chapter keeps the book and its sections.
    expect((await run("save", [1, 2])).body.error).toMatch(/Chapter 1 has concepts already/);
    const sections = db.prepare("SELECT id FROM sections ORDER BY id").pluck().all();

    // The preview of a new chapter shows only the concepts of that chapter, not the saved concepts.
    await run("preview", [2]);
    await app.idle();
    const sources = (await book()).report!.conceptMap!.flatMap((module) => module.concepts.flatMap((concept) => concept.sources));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.text.startsWith("Fixture Book, 2."))).toBe(true);

    await run("save", [2]);
    await app.idle();
    expect(db.prepare("SELECT id FROM sections ORDER BY id").pluck().all()).toEqual(sections);
    expect((await book()).chapters.filter((chapter) => chapter.hasConcepts).map((chapter) => chapter.number)).toEqual([1, 2]);

    // A new upload of a saved book keeps the old file and opens the same book.
    expect((await upload("git", "other-name.epub", epub)).body).toEqual({ book: "fixture-book" });
    expect(existsSync(join(dataDir, "subjects", "git", "books", "fixture-book", "other-name.epub"))).toBe(false);

    // If the sections in the database do not match the parse, the plan shows the problem.
    db.prepare("UPDATE sections SET path = 'other.md' WHERE chapter = 5").run();
    expect((await book()).problem).toMatch(/do not match the new parse/);
  });

  it("refuses a run with a wrong mode or with no chapters", async () => {
    start(new FakeLlm());
    await post("/api/subjects", { name: "Git" });
    await upload("git", "fixture.epub", epub);
    expect((await run("other", [1])).status).toBe(400);
    expect((await run("preview", [])).status).toBe(400);
    expect((await post("/api/subjects/git/books/no-book/ingest", { mode: "preview", chapters: [1] })).status).toBe(404);
    await run("preview", [9]);
    await app.idle();
    expect((await book()).run).toMatchObject({ status: "failed", error: "The book has no chapter 9." });
  });

  it("runs one ingest at a time, stops after the current chapter, and continues from the cache", async () => {
    const llm = new GatedLlm();
    start(llm);
    await post("/api/subjects", { name: "Git" });
    await upload("git", "fixture.epub", epub);

    llm.close();
    const first = (await run("preview", [2, 3])).body;
    await llm.waiting;
    expect((await run("preview", [4])).status).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/subjects/git" })).statusCode).toBe(409);
    const subject = (await get<SubjectDetail>("/api/subjects/git")).body;
    expect(subject.ingest).toMatchObject({ id: first.id, step: 'Finding the concepts in chapter 1 of 2, "Branching".', done: 0, total: 6 });

    expect((await post<IngestView>(`/api/ingests/${first.id}/stop`)).body).toMatchObject({ status: "running", stopping: true });
    llm.open();
    await app.idle();
    expect((await get<IngestView>(`/api/ingests/${first.id}`)).body).toMatchObject({ status: "stopped", stopping: false });
    expect([...new Set(extractedSections(llm.inner).map((id) => id.split(".")[0]))]).toEqual(["2"]);

    // The next run takes chapter 2 from the cache.
    const before = extractedSections(llm.inner).length;
    await run("preview", [2, 3]);
    await app.idle();
    expect((await book()).run).toMatchObject({ status: "done" });
    expect(extractedSections(llm.inner).slice(before).every((id) => id.startsWith("3."))).toBe(true);
  });

  it("marks a run that lost its job as failed at the start of the server", async () => {
    start(new FakeLlm());
    await post("/api/subjects", { name: "Git" });
    const subjectId = db.prepare("SELECT id FROM subjects").pluck().get();
    db.prepare("INSERT INTO ingests (subject_id, book, file, title, mode, status) VALUES (?, 'b', 'f.epub', 'B', 'save', 'running')").run(subjectId);
    const restarted = buildServer({ db, dataDir, llm: new FakeLlm() });
    expect(db.prepare("SELECT status, error FROM ingests").get()).toEqual({
      status: "failed",
      error: "The tutor stopped during the run. A new run takes the finished chapters from the cache.",
    });
    await restarted.close();
  });
});

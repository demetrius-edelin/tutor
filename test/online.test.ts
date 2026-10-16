import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import type { Fetcher } from "../src/ingest/web/http.js";
import type { LlmClient } from "../src/llm/index.js";
import type { BookView, FetchStartView, IngestView, OnlineTocView, SubjectDetail } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { FakeLlm } from "./fakes/llm.js";
import { fakeSite, html, prose } from "./fakes/site.js";

// A documentation site with an llms.txt file. Each folder of /docs/ is a chapter.
const LLMS_TXT = `# Help Center

- [Introduction](https://site.test/docs/start/intro.md)
- [Install](https://site.test/docs/start/install.md)
- [Secret](https://site.test/docs/secret/page.md)
- [Basics](https://site.test/docs/use/basics.md)
- [Missing](https://site.test/docs/use/missing.md)
`;

const markdown = (title: string, topic: string) => ({ contentType: "text/markdown", body: `# ${title}\n\n${prose(topic, 60)}\n` });

const docsSite = () =>
  fakeSite({
    "https://site.test/robots.txt": { contentType: "text/plain", body: "User-agent: *\nDisallow: /docs/secret/" },
    "https://site.test/llms.txt": { contentType: "text/plain", body: LLMS_TXT },
    "https://site.test/docs/start/intro.md": markdown("Introduction", "intro"),
    "https://site.test/docs/start/install.md": markdown("Install", "install"),
    "https://site.test/docs/use/basics.md": markdown("Basics", "basic"),
  });

// A site that waits at one address until the test opens the gate, so that a test can act during a download.
function gatedSite(site: Fetcher & { requested: string[] }, address: string) {
  let release = () => {};
  let arrive = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (arrive = resolve));
  const fetcher: Fetcher = async (url) => {
    if (url === address) {
      arrive();
      await gate;
    }
    return site(url);
  };
  return { fetcher, requested: site.requested, waiting, open: () => release() };
}

let db: Db;
let dataDir: string;
let app: TutorServer;

afterEach(async () => {
  await app.close();
});

function start(fetcher: Fetcher, llm: LlmClient | null = new FakeLlm()) {
  dataDir = mkdtempSync(join(tmpdir(), "tutor-online-"));
  db = openDb(":memory:");
  app = buildServer({
    db,
    dataDir,
    llm,
    fetcher,
    fetchPauseMs: 0,
    // The tests of online books never run yt-dlp.
    video: {
      ytDlp: async () => {
        throw new Error("The tests do not run yt-dlp.");
      },
    },
    ...(llm ? { modelName: "fake model" } : { llmError: "No model is selected." }),
  });
}

const get = async <T>(url: string) => {
  const response = await app.inject({ method: "GET", url });
  return { status: response.statusCode, body: response.json() as T & { error?: string } };
};

const post = async <T>(url: string, payload: object = {}) => {
  const response = await app.inject({ method: "POST", url, payload });
  return { status: response.statusCode, body: response.json() as T & { error?: string } };
};

type WebTocView = Extract<OnlineTocView, { kind: "web" }>;
const findChapters = (url: string, toc?: string) => post<WebTocView>("/api/fetch/toc", { url, ...(toc ? { toc } : {}) });

async function docsToc() {
  const { status, body } = await findChapters("https://site.test/docs/");
  expect(status).toBe(200);
  return body.toc;
}

describe("Find the table of contents", () => {
  it("uses llms.txt with no model", async () => {
    start(docsSite(), null);
    const { status, body } = await findChapters("site.test/docs/");
    expect(status).toBe(200);
    expect(body.secondsPerPage).toBe(0);
    expect(body.kind).toBe("web");
    expect(body.toc).toMatchObject({ title: "Help Center", source: "llms.txt", scope: "https://site.test/docs/" });
    expect(body.toc.chapters.map((chapter) => [chapter.title, chapter.pages.length])).toEqual([
      ["Start", 2],
      ["Secret", 1],
      ["Use", 2],
    ]);
  });

  it("asks the model for a site with no llms.txt, and needs a model for it", async () => {
    const site = fakeSite({
      "https://site.test/book/": html(`<ol><li><a href="one.html">One</a></li><li><a href="two.html">Two</a></li></ol>`, "The Book"),
    });
    start(site, null);
    const refused = await findChapters("https://site.test/book/");
    expect(refused).toEqual({ status: 503, body: { error: "No model is selected." } });

    await app.close();
    const llm = new FakeLlm();
    start(site, llm);
    const { body } = await findChapters("https://site.test/book/");
    expect(llm.count("toc")).toBe(1);
    expect(body.toc).toMatchObject({ title: "Fake Book", source: "html" });
    expect(body.toc.chapters.map((chapter) => chapter.title)).toEqual(["One", "Two"]);
  });

  it("names the form field in the advice about a missing table of contents", async () => {
    start(fakeSite({ "https://site.test/book/": html(`<a href="https://other.test/">Other</a>`) }));
    const { status, body } = await findChapters("https://site.test/book/");
    expect(status).toBe(400);
    expect(body.error).toBe(
      'https://site.test/book/ has no links to pages in https://site.test/book/. Type the address of a page that lists the pages in the field "Table of contents".',
    );
  });

  it("refuses an address that is not a web page, and a table of contents for a YouTube address", async () => {
    start(docsSite());
    expect((await findChapters("")).status).toBe(400);
    expect((await findChapters("ftp://site.test/docs/")).body.error).toMatch(/is not a web address/);
    expect((await findChapters("https://site.test/docs/", "not an address")).body.error).toMatch(/is not a web address/);
    expect((await findChapters("https://www.youtube.com/watch?v=ahCwqrYpIuM", "https://site.test/toc")).body.error).toMatch(
      /does not apply to a YouTube address/,
    );
  });

  it("gives the reason if the site does not answer", async () => {
    start(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    expect(await findChapters("https://nowhere.test/book/")).toEqual({
      status: 502,
      body: { error: "The tutor cannot download https://nowhere.test/book/: ENOTFOUND." },
    });
  });
});

describe("Download an online book", () => {
  it("writes the EPUB file, keeps a copy in the folder of the book, and shows the plan with the skipped pages", async () => {
    start(docsSite());
    await post("/api/subjects", { name: "Docs" });
    const toc = await docsToc();

    const started = await post<FetchStartView>("/api/subjects/docs/fetch", { toc, chapters: [1, 2, 3] });
    expect(started.status).toBe(200);
    expect(started.body.existing).toBeNull();
    expect(started.body.run).toMatchObject({ mode: "fetch", book: "help-center", title: "Help Center", chapters: [1, 2, 3], status: "running", total: 5 });
    await app.idle();

    const run = (await get<IngestView>(`/api/ingests/${started.body.run!.id}`)).body;
    expect(run).toMatchObject({ status: "done", step: "", error: null });
    expect(run).toMatchObject({ video: false });
    expect(run.download).toEqual({
      kind: "web",
      pages: 3,
      words: expect.any(Number),
      images: 0,
      skipped: [
        { url: "https://site.test/docs/secret/page.md", reason: "robots.txt disallows it" },
        { url: "https://site.test/docs/use/missing.md", reason: "HTTP status 404" },
      ],
    });
    const epub = join(dataDir, "web", "help-center.epub");
    expect(existsSync(epub)).toBe(true);
    expect(readFileSync(join(dataDir, "subjects", "docs", "books", "help-center", "help-center.epub"))).toEqual(readFileSync(epub));

    // The book page opens in the plan state. The chapter "Secret" has no page, so the book has two chapters.
    const book = (await get<BookView>("/api/subjects/docs/books/help-center")).body;
    expect(book).toMatchObject({ title: "Help Center", saved: false, problem: null, report: null, run: { mode: "fetch", status: "done" } });
    expect(book.chapters.map((chapter) => [chapter.title, chapter.sections])).toEqual([
      ["Start", 2],
      ["Use", 1],
    ]);
    expect((await get<SubjectDetail>("/api/subjects/docs")).body.unsavedBooks).toEqual([{ slug: "help-center", title: "Help Center" }]);

    // A preview of the downloaded book works as for an uploaded file.
    await post("/api/subjects/docs/books/help-center/ingest", { mode: "preview", chapters: [1] });
    await app.idle();
    expect((await get<BookView>("/api/subjects/docs/books/help-center")).body.report).toMatchObject({ preview: true, chapters: [{ title: "Start" }] });
  });

  it("offers the EPUB file of an earlier download with the same title, or downloads again", async () => {
    const site = docsSite();
    start(site);
    await post("/api/subjects", { name: "Docs" });
    await post("/api/subjects", { name: "Other" });
    const toc = await docsToc();
    await post("/api/subjects/docs/fetch", { toc, chapters: [3] });
    await app.idle();
    expect(existsSync(join(dataDir, "web", "help-center-use.epub"))).toBe(true);

    // The same chapters in another subject give the same file. The download does not start.
    const requests = site.requested.length;
    const again = await post<FetchStartView>("/api/subjects/other/fetch", { toc, chapters: [3] });
    expect(again.body).toEqual({ run: null, existing: { file: "help-center-use.epub", title: "Help Center - Use" } });
    expect(site.requested.length).toBe(requests);

    // "Use the downloaded file"
    expect(await post("/api/subjects/other/books/web", { file: "help-center-use.epub" })).toEqual({ status: 200, body: { book: "help-center-use" } });
    expect((await get<BookView>("/api/subjects/other/books/help-center-use")).body).toMatchObject({ title: "Help Center - Use", run: null });
    expect((await post("/api/subjects/other/books/web", { file: "../tutor.epub" })).status).toBe(400);
    expect((await post("/api/subjects/other/books/web", { file: "none.epub" })).status).toBe(404);
    expect((await post("/api/subjects/none/books/web", { file: "help-center-use.epub" })).status).toBe(404);

    // "Download again"
    const replaced = await post<FetchStartView>("/api/subjects/other/fetch", { toc, chapters: [3], again: true });
    expect(replaced.body.run).toMatchObject({ mode: "fetch", status: "running" });
    await app.idle();
    expect(site.requested.length).toBeGreaterThan(requests);
  });

  it("refuses a table of contents with a page outside its scope, and a wrong selection", async () => {
    start(docsSite());
    await post("/api/subjects", { name: "Docs" });
    const toc = await docsToc();
    const outside = { ...toc, chapters: [{ title: "Other", pages: [{ title: "Other", url: "https://other.test/docs/page" }] }] };
    expect((await post("/api/subjects/docs/fetch", { toc: outside, chapters: [1] })).body.error).toMatch(/is not in https:\/\/site.test\/docs\//);
    expect((await post("/api/subjects/docs/fetch", { toc: { title: "No chapters" }, chapters: [1] })).status).toBe(400);
    expect((await post("/api/subjects/docs/fetch", { toc, chapters: [] })).body.error).toBe("Select at least one chapter.");
    expect((await post("/api/subjects/docs/fetch", { toc, chapters: [4] })).body.error).toBe("The site has 3 chapters. There is no chapter 4.");
    expect((await post("/api/subjects/none/fetch", { toc, chapters: [1] })).status).toBe(404);
  });

  it("runs one download at a time, and a stopped download writes no EPUB file", async () => {
    const site = gatedSite(docsSite(), "https://site.test/docs/start/install.md");
    start(site.fetcher);
    await post("/api/subjects", { name: "Docs" });
    const toc = await docsToc();

    const run = (await post<FetchStartView>("/api/subjects/docs/fetch", { toc, chapters: [1, 3] })).body.run!;
    await site.waiting;
    expect((await get<SubjectDetail>("/api/subjects/docs")).body.ingest).toMatchObject({
      id: run.id,
      mode: "fetch",
      step: 'Downloading page 2 of 4, "Install".',
      done: 1,
      total: 4,
    });
    expect((await get<BookView>("/api/subjects/docs/books/help-center-start-use")).body.run).toMatchObject({ status: "running" });
    const second = await post("/api/subjects/docs/fetch", { toc, chapters: [1] });
    expect(second).toEqual({ status: 409, body: { error: 'The tutor downloads "Help Center - Start, Use" now. Only one run can work at a time.' } });
    expect((await app.inject({ method: "DELETE", url: "/api/subjects/docs" })).statusCode).toBe(409);

    expect((await post<IngestView>(`/api/ingests/${run.id}/stop`)).body).toMatchObject({ status: "running", stopping: true });
    site.open();
    await app.idle();
    expect((await get<IngestView>(`/api/ingests/${run.id}`)).body).toMatchObject({ status: "stopped", stopping: false, download: null });
    expect(existsSync(join(dataDir, "web", "help-center-start-use.epub"))).toBe(false);
    // The last page of the run is the page at the gate.
    expect(site.requested).toContain("https://site.test/docs/start/install.md");
    expect(site.requested).not.toContain("https://site.test/docs/use/basics.md");

    const book = (await get<BookView>("/api/subjects/docs/books/help-center-start-use")).body;
    expect(book).toMatchObject({ title: "Help Center - Start, Use", chapters: [], run: { status: "stopped" } });
    expect(book.problem).toBe("The tutor has no EPUB file of this book, because the download did not finish.");
    expect((await post("/api/subjects/docs/books/help-center-start-use/ingest", { mode: "preview", chapters: [1] })).status).toBe(404);
  });

  it("marks a download that lost its job as failed at the start of the server", async () => {
    start(docsSite());
    await post("/api/subjects", { name: "Docs" });
    const subjectId = db.prepare("SELECT id FROM subjects").pluck().get();
    db.prepare("INSERT INTO ingests (subject_id, book, file, title, mode, status) VALUES (?, 'b', 'web/b.epub', 'B', 'fetch', 'running')").run(subjectId);
    const restarted = buildServer({ db, dataDir });
    expect(db.prepare("SELECT status, error FROM ingests").get()).toEqual({
      status: "failed",
      error: "The tutor stopped during the download. Start the download again.",
    });
    await restarted.close();
  });
});

describe("Add an EPUB file from data/web/", () => {
  it("refuses a file that the parser cannot read", async () => {
    start(docsSite());
    await post("/api/subjects", { name: "Docs" });
    mkdirSync(join(dataDir, "web"), { recursive: true });
    writeFileSync(join(dataDir, "web", "broken.epub"), "not a zip file");
    expect((await post("/api/subjects/docs/books/web", { file: "broken.epub" })).status).toBe(400);
  });
});

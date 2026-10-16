import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VideoConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { estimateCost, type TranscribeRequest, type TranscribeResult, type VideoClient } from "../src/ingest/video/client.js";
import type { LlmClient } from "../src/llm/index.js";
import { checkReferences } from "../src/llm/references.js";
import type { YtDlpRunner } from "../src/ingest/video/ytdlp.js";
import type {
  BookView,
  ConceptMapView,
  FetchStartView,
  IngestView,
  LessonView,
  OnlineTocView,
  SectionView,
  SubjectDetail,
  VideoToc,
} from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import type { VideoAccess } from "../src/server/videos.js";
import { FakeLlm } from "./fakes/llm.js";
import { prose } from "./fakes/site.js";

// The facts that the fake yt-dlp gives, in the JSON form of yt-dlp.
const VIDEOS: Record<string, { title: string; duration: number; chapters?: { title: string; start_time: number; end_time: number }[] }> = {
  aaaaaaaaaaa: {
    title: "One",
    duration: 600,
    chapters: [
      { title: "Intro", start_time: 0, end_time: 20 },
      { title: "Types", start_time: 20, end_time: 300 },
      { title: "Generics", start_time: 300, end_time: 600 },
    ],
  },
  bbbbbbbbbbb: { title: "Two", duration: 200 },
  ccccccccccc: { title: "Three", duration: 6000 },
  ddddddddddd: { title: "Four", duration: 300 },
  // The playlist gives no length for this video. yt-dlp then finds a length of more than 90 minutes.
  eeeeeeeeeee: { title: "Five", duration: 6000 },
};

const PLAYLIST = {
  id: "PLcourse1234",
  title: "A Course",
  channel: "Teacher",
  entries: [
    { id: "aaaaaaaaaaa", title: "One", duration: 600 },
    { id: "bbbbbbbbbbb", title: "Two", duration: 200 },
    { id: "ccccccccccc", title: "Three", duration: 6000 },
    { id: "ddddddddddd", title: "Four", duration: 300 },
    { id: "eeeeeeeeeee", title: "Five", duration: null },
  ],
};

function fakeYtDlp(): YtDlpRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args.includes("--flat-playlist")) return JSON.stringify(PLAYLIST);
    const id = /[?&]v=([\w-]{11})/.exec(args.find((arg) => arg.includes("watch?v=")) ?? "")?.[1] ?? "";
    const video = VIDEOS[id];
    if (!video) throw new Error("Video unavailable");
    return JSON.stringify({ id, channel: "Teacher", language: "en", ...video });
  };
  return Object.assign(run, { calls });
}

// Transcripts that pass the checks: a paragraph at least each 3 minutes, and the last one near the end.
const TRANSCRIPTS: Record<string, string> = {
  aaaaaaaaaaa: `[0:00] Music.\n[0:30] A **type annotation** tells the type. ${prose("type", 60)}\n[2:00] ${prose("more", 50)}\n[4:00] ${prose("more2", 50)}\n[5:10] ${prose("generic", 60)}\n[7:00] ${prose("generic2", 40)}\n[9:00] ${prose("end", 20)}`,
  bbbbbbbbbbb: `[0:00] ${prose("two", 60)}\n[1:40] ${prose("twob", 60)}`,
  ddddddddddd: `[0:00] ${prose("four", 60)}\n[2:30] ${prose("fourb", 60)}\n[4:00] ${prose("fourc", 30)}`,
};

// A fake video model. It can wait at one video until the test opens the gate.
function fakeClient(gateAt?: string) {
  const calls: TranscribeRequest[] = [];
  let release = () => {};
  let arrive = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (arrive = resolve));
  const client: VideoClient = {
    async transcribe(request): Promise<TranscribeResult> {
      calls.push(request);
      const id = request.url.slice(-11);
      if (id === gateAt) {
        arrive();
        await gate;
      }
      return { text: TRANSCRIPTS[id] ?? "[0:00] Nothing.", finishReason: "stop", inputTokens: 1000, outputTokens: 100, cost: 0.01 };
    },
  };
  return { client, calls, waiting, open: () => release() };
}

const CONFIG: VideoConfig = { provider: "openrouter", model: "google/gemini-test", apiKey: "key" };
const PRICES = { input: 0.0000003, output: 0.0000025 };

let db: Db;
let dataDir: string;
let app: TutorServer;

afterEach(async () => {
  await app.close();
});

function start(video: Partial<VideoAccess>, llm: LlmClient = new FakeLlm()) {
  dataDir = mkdtempSync(join(tmpdir(), "tutor-video-app-"));
  db = openDb(":memory:");
  const ytDlp = fakeYtDlp();
  app = buildServer({ db, dataDir, llm, modelName: "fake model", video: { ytDlp: async () => ytDlp, prices: async () => PRICES, ...video } });
  return ytDlp;
}

const get = async <T>(url: string) => {
  const response = await app.inject({ method: "GET", url });
  return { status: response.statusCode, body: response.json() as T & { error?: string } };
};

const post = async <T>(url: string, payload: object = {}) => {
  const response = await app.inject({ method: "POST", url, payload });
  return { status: response.statusCode, body: response.json() as T & { error?: string } };
};

async function findVideo(url: string): Promise<VideoToc> {
  const { status, body } = await post<OnlineTocView>("/api/fetch/toc", { url });
  expect(status).toBe(200);
  expect(body.kind).toBe("video");
  return (body as Extract<OnlineTocView, { kind: "video" }>).video;
}

const transcript = (id: string) => join(dataDir, "web", "transcripts", `${id}.json`);

describe("Find a YouTube video or playlist", () => {
  it("gives the facts of one video with its chapters, the video model, and the cost of one second", async () => {
    const fake = fakeClient();
    start({ config: CONFIG, client: () => fake.client });
    const video = await findVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLcourse1234");
    expect(video).toMatchObject({
      kind: "video",
      id: "aaaaaaaaaaa",
      source: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      playlist: "https://www.youtube.com/playlist?list=PLcourse1234",
      title: "One",
      channel: "Teacher",
      videos: [{ id: "aaaaaaaaaaa", title: "One", duration: 600, cached: false }],
      model: "openrouter google/gemini-test",
      modelError: null,
      maxSeconds: 5400,
      oneChapterSeconds: 1800,
      costNote: null,
    });
    expect(video.chapters).toEqual([
      { title: "Intro", start: 0 },
      { title: "Types", start: 20 },
      { title: "Generics", start: 300 },
    ]);
    expect(video.dollarsPerSecond).toBeCloseTo(estimateCost(1, PRICES), 12);
    expect(fake.calls).toEqual([]);
  });

  it("gives the videos of a playlist, and the message about the video model if .env has none", async () => {
    start({ config: null, error: "No video model is selected." });
    const playlist = await findVideo("https://www.youtube.com/playlist?list=PLcourse1234");
    expect(playlist).toMatchObject({ kind: "playlist", title: "A Course", chapters: [], model: null, modelError: "No video model is selected." });
    expect(playlist.videos.map((video) => video.duration)).toEqual([600, 200, 6000, 300, null]);
    const started = await post("/api/subjects", { name: "Videos" }).then(() => post("/api/subjects/videos/fetch", { video: playlist, chapters: [1] }));
    expect(started).toEqual({ status: 503, body: { error: "No video model is selected." } });
  });

  it("gives no cost for the Gemini API of Google, and the message of yt-dlp for a video that it cannot read", async () => {
    start({ config: { ...CONFIG, provider: "google", model: "gemini-test" } });
    expect(await findVideo("https://youtu.be/bbbbbbbbbbb")).toMatchObject({
      dollarsPerSecond: null,
      costNote: "No cost estimate for the Gemini API of Google. Its free tier allows 8 hours of YouTube video a day.",
    });
    const missing = await post("/api/fetch/toc", { url: "https://youtu.be/zzzzzzzzzzz" });
    expect(missing.status).toBe(502);
    expect(missing.body.error).toMatch(/yt-dlp cannot read https:\/\/youtu.be\/zzzzzzzzzzz: Video unavailable/);
  });
});

describe("Download the transcript of a video", () => {
  it("writes a short video as one chapter with a section for each YouTube chapter, and a second download uses the cache", async () => {
    const fake = fakeClient();
    start({ config: CONFIG, client: () => fake.client });
    await post("/api/subjects", { name: "Videos" });
    const video = await findVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa");

    const started = await post<FetchStartView>("/api/subjects/videos/fetch", { video, chapters: [] });
    expect(started.body.run).toMatchObject({ mode: "fetch", video: true, book: "one", chapters: [1], status: "running", total: 1 });
    await app.idle();
    const run = (await get<IngestView>(`/api/ingests/${started.body.run!.id}`)).body;
    expect(run).toMatchObject({ status: "done", error: null });
    expect(run.download).toEqual({ kind: "video", videos: 1, words: expect.any(Number), requests: 1, cost: 0.01, skipped: [] });
    expect(existsSync(join(dataDir, "web", "one.epub"))).toBe(true);
    expect(existsSync(transcript("aaaaaaaaaaa"))).toBe(true);

    const book = (await get<BookView>("/api/subjects/videos/books/one")).body;
    expect(book).toMatchObject({ title: "One", saved: false, problem: null, run: { video: true, status: "done" } });
    // The video is shorter than 30 minutes, so it is one chapter. The parser joins the very short intro to the next section.
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["One"]);
    expect(book.chapters[0]!.sections).toBeGreaterThan(1);

    // The transcript is in the cache now. The download of the same video again makes no request.
    const again = await findVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(again.videos[0]!.cached).toBe(true);
    expect((await post<FetchStartView>("/api/subjects/videos/fetch", { video: again })).body.existing).toEqual({ file: "one.epub", title: "One" });
    await post("/api/subjects/videos/fetch", { video: again, again: true });
    await app.idle();
    expect(fake.calls).toHaveLength(1);
    expect((await get<BookView>("/api/subjects/videos/books/one")).body.run).toMatchObject({ status: "done", download: { requests: 0, cost: null } });
  });

  it("refuses facts that are not valid", async () => {
    start({ config: CONFIG, client: () => fakeClient().client });
    await post("/api/subjects", { name: "Videos" });
    const video = await findVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    const bad = { ...video, videos: [{ ...video.videos[0]!, id: "../../../x" }] };
    expect((await post("/api/subjects/videos/fetch", { video: bad })).body.error).toBe("The facts of the video are not valid. Find the video again.");
    expect((await post("/api/subjects/videos/fetch", { video: { title: "No id" } })).status).toBe(400);
  });
});

describe("Download the transcripts of a playlist", () => {
  it("refuses a video that is too long, stops after the current video, and continues from the cache", async () => {
    const fake = fakeClient("bbbbbbbbbbb");
    start({ config: CONFIG, client: () => fake.client });
    await post("/api/subjects", { name: "Videos" });
    const playlist = await findVideo("https://www.youtube.com/playlist?list=PLcourse1234");
    expect((await post("/api/subjects/videos/fetch", { video: playlist, chapters: [3] })).body.error).toMatch(/^Video 3 is too long\./);
    expect((await post("/api/subjects/videos/fetch", { video: playlist, chapters: [] })).body.error).toBe("Select at least one video.");
    expect((await post("/api/subjects/videos/fetch", { video: playlist, chapters: [9] })).body.error).toBe(
      "The playlist has 5 videos. There is no video 9.",
    );

    const run = (await post<FetchStartView>("/api/subjects/videos/fetch", { video: playlist, chapters: [1, 2, 4] })).body.run!;
    expect(run).toMatchObject({ title: "A Course - One, Two, Four", book: "a-course-one-two-four", total: 3 });
    await fake.waiting;
    expect((await get<SubjectDetail>("/api/subjects/videos")).body.ingest).toMatchObject({
      id: run.id,
      video: true,
      step: 'Transcribing video 2 of 3, "Two".',
      done: 1,
      total: 3,
    });
    expect((await post("/api/subjects/videos/fetch", { video: playlist, chapters: [4] })).status).toBe(409);
    await post(`/api/ingests/${run.id}/stop`);
    fake.open();
    await app.idle();

    expect((await get<IngestView>(`/api/ingests/${run.id}`)).body).toMatchObject({ status: "stopped", download: null });
    expect(existsSync(join(dataDir, "web", "a-course-one-two-four.epub"))).toBe(false);
    // The video at the gate finished, so its transcript is in the cache. The next video did not start.
    expect([transcript("aaaaaaaaaaa"), transcript("bbbbbbbbbbb"), transcript("ddddddddddd")].map((file) => existsSync(file))).toEqual([
      true,
      true,
      false,
    ]);
    const stopped = (await get<BookView>("/api/subjects/videos/books/a-course-one-two-four")).body;
    expect(stopped).toMatchObject({ chapters: [], run: { status: "stopped", video: true } });

    // The next download takes the two finished videos from the cache.
    await post("/api/subjects/videos/fetch", { video: playlist, chapters: [1, 2, 4] });
    await app.idle();
    expect(fake.calls.map((call) => call.url.slice(-11))).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", "ddddddddddd"]);
    const book = (await get<BookView>("/api/subjects/videos/books/a-course-one-two-four")).body;
    expect(book.run).toMatchObject({ status: "done", download: { videos: 3, requests: 1 } });
    // Each video is a chapter. The YouTube chapters of a video are its sections, and the parser joins a very short section to the next.
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["One", "Two", "Four"]);
    expect(book.chapters[0]!.sections).toBeGreaterThan(1);
  });

  it("skips a video that yt-dlp finds too long, and a video that it cannot read", async () => {
    const fake = fakeClient();
    start({ config: CONFIG, client: () => fake.client });
    await post("/api/subjects", { name: "Videos" });
    const playlist = await findVideo("https://www.youtube.com/playlist?list=PLcourse1234");
    const withMissing = { ...playlist, videos: [...playlist.videos, { id: "zzzzzzzzzzz", title: "Gone", duration: 60, cached: false }] };
    const run = (await post<FetchStartView>("/api/subjects/videos/fetch", { video: withMissing, chapters: [2, 5, 6] })).body.run!;
    await app.idle();
    const done = (await get<IngestView>(`/api/ingests/${run.id}`)).body;
    expect(done).toMatchObject({ status: "done", download: { videos: 1 } });
    expect(done.download!.skipped).toEqual([
      { url: "https://www.youtube.com/watch?v=eeeeeeeeeee", reason: expect.stringMatching(/^the video is 1 h 40 min long\./) },
      { url: "https://www.youtube.com/watch?v=zzzzzzzzzzz", reason: "yt-dlp cannot read the video: Video unavailable" },
    ]);

    // With no video to transcribe, the download fails with the reasons.
    const none = (await post<FetchStartView>("/api/subjects/videos/fetch", { video: playlist, chapters: [5] })).body.run!;
    await app.idle();
    expect((await get<IngestView>(`/api/ingests/${none.id}`)).body.error).toMatch(/^The tutor cannot transcribe the selected videos\./);
  });
});

describe("Watch the video at a reference", () => {
  it("gives the point in the video for the sources, the section, and the references of a lesson", async () => {
    // The lesson quotes the paragraph at 2:00 of the section "Types".
    const llm = new FakeLlm({
      text: (request) => checkReferences("The concept [1].", [{ number: 1, sourceId: request.sources[0]!.id, quote: "more3 more4 more5" }], request.sources),
    });
    start({ config: CONFIG, client: () => fakeClient().client }, llm);
    await post("/api/subjects", { name: "Videos" });
    await post("/api/subjects/videos/fetch", { video: await findVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa") });
    await app.idle();
    await post("/api/subjects/videos/books/one/ingest", { mode: "save", chapters: [1] });
    await app.idle();

    // The fake model makes one concept for each section, with the title of the section.
    const map = (await get<ConceptMapView>("/api/subjects/videos/map")).body;
    const concept = map.modules.flatMap((module) => module.concepts).find((item) => item.name === "Types")!;
    // The quote of the fake model is not in the text, so the source starts at the first paragraph of the section.
    // The parser joins the very short intro to this section, so the section starts at 0:00.
    expect(concept.sources[0]!.video).toEqual({ id: "aaaaaaaaaaa", start: 0 });
    expect((await get<SectionView>(`/api/sections/${concept.sources[0]!.sectionId}`)).body.video).toEqual({ id: "aaaaaaaaaaa", start: 0 });

    const lesson = (await post<LessonView>(`/api/concepts/${concept.id}/lesson`)).body;
    expect(lesson.lesson!.references).toEqual([expect.objectContaining({ quote: "more3 more4 more5", video: { id: "aaaaaaaaaaa", start: 120 } })]);
    expect((await get<LessonView>(`/api/concepts/${concept.id}/lesson`)).body.lesson!.references[0]!.video).toEqual({ id: "aaaaaaaaaaa", start: 120 });
  });
});

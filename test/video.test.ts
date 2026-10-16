import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VideoConfig } from "../src/config.js";
import { parseBook } from "../src/ingest/parse.js";
import { fetchVideos, playlistBookTitle, splitByParts } from "../src/ingest/video/book.js";
import {
  estimateCost,
  GEMINI_INTERACTIONS_URL,
  GeminiVideoClient,
  openRouterPrices,
  OpenRouterVideoClient,
  type TranscribeRequest,
  type TranscribeResult,
  type VideoClient,
} from "../src/ingest/video/client.js";
import { addNotes, checkTranscript, CODE_NOTE, maxTokensFor, parseTranscript, TABLE_NOTE } from "../src/ingest/video/transcript.js";
import { ensureYtDlp, readPlaylist, readVideo, ytDlpAsset, ytDlpRunner } from "../src/ingest/video/ytdlp.js";
import {
  formatLength,
  formatTime,
  parseYoutubeUrl,
  playlistFacts,
  timeUrl,
  videoFacts,
  videoMoment,
  type VideoFacts,
} from "../src/ingest/video/youtube.js";
import { LlmError } from "../src/llm/types.js";

// Text with different words, for example "value0 value1 value2".
const prose = (topic: string, count: number) => Array.from({ length: count }, (_, i) => `${topic}${i}`).join(" ");
const tempDir = () => mkdtempSync(join(tmpdir(), "tutor-video-"));

describe("YouTube addresses", () => {
  it("finds the video or the playlist", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=ahCwqrYpIuM")).toEqual({ kind: "video", id: "ahCwqrYpIuM", playlistId: null });
    expect(parseYoutubeUrl("https://youtu.be/ahCwqrYpIuM?t=42")).toEqual({ kind: "video", id: "ahCwqrYpIuM", playlistId: null });
    expect(parseYoutubeUrl("https://m.youtube.com/shorts/ahCwqrYpIuM")).toEqual({ kind: "video", id: "ahCwqrYpIuM", playlistId: null });
    expect(parseYoutubeUrl("https://www.youtube.com/playlist?list=PLabcdefghij12")).toEqual({ kind: "playlist", id: "PLabcdefghij12" });
  });

  it("gives the video for an address with a video and a playlist", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=ahCwqrYpIuM&list=PLabcdefghij12&index=2")).toEqual({
      kind: "video",
      id: "ahCwqrYpIuM",
      playlistId: "PLabcdefghij12",
    });
  });

  it("does not accept other addresses", () => {
    expect(parseYoutubeUrl("https://example.com/watch?v=ahCwqrYpIuM")).toBeNull();
    expect(parseYoutubeUrl("https://www.youtube.com/@fireship")).toBeNull();
    expect(parseYoutubeUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYoutubeUrl("not an address")).toBeNull();
  });

  it("writes times and links to a time", () => {
    expect(formatTime(5)).toBe("0:05");
    expect(formatTime(754)).toBe("12:34");
    expect(formatTime(3845)).toBe("1:04:05");
    expect(formatLength(721)).toBe("12 min");
    expect(formatLength(3900)).toBe("1 h 05 min");
    expect(timeUrl("ahCwqrYpIuM", 754.6)).toBe("https://www.youtube.com/watch?v=ahCwqrYpIuM&t=754s");
  });
});

describe("The point in the video of a quote", () => {
  const link = (seconds: number) => `[${formatTime(seconds)}](${timeUrl("aaaaaaaaaaa", seconds)})`;
  const section = `### Types\n\n${link(30)} A **type annotation** tells the compiler the type.\n\n${link(120)} Use an interface for the shape of an object.\n\n_The tutor read this code from the video:_\n\n\`\`\`ts\ninterface User { name: string }\n\`\`\`\n\n${link(200)} A union type allows two types.`;

  it("gives the time of the paragraph with the quote, or of the first paragraph", () => {
    expect(videoMoment(section)).toEqual({ id: "aaaaaaaaaaa", start: 30 });
    expect(videoMoment(section, "an interface for the shape")).toEqual({ id: "aaaaaaaaaaa", start: 120 });
    // The code after a paragraph belongs to the time of that paragraph.
    expect(videoMoment(section, "interface User")).toEqual({ id: "aaaaaaaaaaa", start: 120 });
    expect(videoMoment(section, "A union type allows two types, also null")).toEqual({ id: "aaaaaaaaaaa", start: 200 });
    expect(videoMoment(section, "words that are not in the text")).toEqual({ id: "aaaaaaaaaaa", start: 30 });
  });

  it("finds the paragraph where a quote across a code block starts, also if each code block has the same note", () => {
    const note = "_The tutor read this code from the video:_";
    const text = [
      `${link(10)} First words of the video.`,
      note,
      "```ts\nlet a = 1;\n```",
      `${link(20)} Second words of the video.`,
      note,
      "```ts\nlet b = 2;\n```",
      `${link(30)} Third words of the video.`,
    ].join("\n\n");
    const quote = `${note} \`\`\`ts let b = 2; \`\`\` ${link(30)} Third words`;
    expect(videoMoment(text, quote)).toEqual({ id: "aaaaaaaaaaa", start: 20 });
  });

  it("gives no point for a section of a book file", () => {
    expect(videoMoment("## Joins\n\nA join combines [two tables](https://example.com/joins).", "two tables")).toBeNull();
  });
});

describe("yt-dlp facts", () => {
  it("reads the facts of a video, with the chapters in time order", () => {
    const facts = videoFacts({
      id: "ahCwqrYpIuM",
      title: "TypeScript - The Basics",
      channel: "Fireship",
      duration: 721,
      language: "en",
      chapters: [
        { title: "Benefits", start_time: 50, end_time: 314 },
        { title: "Intro", start_time: 0, end_time: 50 },
      ],
    });
    expect(facts).toEqual({
      id: "ahCwqrYpIuM",
      title: "TypeScript - The Basics",
      channel: "Fireship",
      duration: 721,
      language: "en",
      chapters: [
        { title: "Intro", start: 0, end: 50 },
        { title: "Benefits", start: 50, end: 314 },
      ],
    });
  });

  it("reads the videos of a playlist, without private and deleted videos", () => {
    const facts = playlistFacts({
      id: "PLabcdefghij12",
      title: "A course",
      uploader: "Teacher",
      entries: [
        { id: "aaaaaaaaaaa", title: "One", duration: 300 },
        { id: "bbbbbbbbbbb", title: "[Private video]", duration: null },
        { id: "ccccccccccc", title: "Three" },
        { id: "ddddddddddd", title: null, duration: null },
      ],
    });
    expect(facts.channel).toBe("Teacher");
    expect(facts.videos).toEqual([
      { id: "aaaaaaaaaaa", title: "One", duration: 300 },
      { id: "ccccccccccc", title: "Three", duration: null },
    ]);
  });

  it("calls yt-dlp with the base arguments, and stops for a video with no length", async () => {
    const calls: string[][] = [];
    const run = ytDlpRunner("/bin/yt-dlp", async (program, args) => {
      calls.push([program, ...args]);
      return args.includes("--flat-playlist")
        ? JSON.stringify({ id: "PLabcdefghij12", title: "Course", channel: "C", entries: [{ id: "aaaaaaaaaaa", title: "One", duration: 60 }] })
        : JSON.stringify({ id: "aaaaaaaaaaa", title: "Live", channel: "C", duration: null });
    });
    expect((await readPlaylist(run, "PLabcdefghij12")).videos).toHaveLength(1);
    await expect(readVideo(run, "aaaaaaaaaaa")).rejects.toThrow(/no length/);
    expect(calls[0]!.slice(0, 5)).toEqual(["/bin/yt-dlp", "--ignore-config", "--no-warnings", "--js-runtimes", `node:${process.execPath}`]);
    expect(calls[0]).toContain("https://www.youtube.com/playlist?list=PLabcdefghij12");
    expect(calls[1]).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  });
});

describe("yt-dlp program", () => {
  it("selects the release file for the system", () => {
    expect(ytDlpAsset("darwin", "arm64")).toBe("yt-dlp_macos");
    expect(ytDlpAsset("win32", "x64")).toBe("yt-dlp.exe");
    expect(ytDlpAsset("linux", "arm64")).toBe("yt-dlp_linux_aarch64");
    expect(ytDlpAsset("freebsd", "x64")).toBeNull();
  });

  const program = new TextEncoder().encode("#!/bin/sh\necho yt-dlp\n");
  const sums = (data: Uint8Array) => new TextEncoder().encode(`${createHash("sha256").update(data).digest("hex")}  yt-dlp_linux\n`);

  it("downloads the program one time, and updates it after one day", async () => {
    const dir = tempDir();
    const downloads: string[] = [];
    const runs: string[][] = [];
    const lines: string[] = [];
    const options = {
      dir,
      platform: "linux" as const,
      arch: "x64",
      log: (line: string) => lines.push(line),
      download: async (url: string) => {
        downloads.push(url);
        return url.endsWith("SHA2-256SUMS") ? sums(program) : program;
      },
      run: async (_program: string, args: string[]) => {
        runs.push(args);
        return "Latest version: 2026.08.19\nyt-dlp is up to date (2026.08.19)\n";
      },
    };
    const path = await ensureYtDlp({ ...options, now: new Date("2026-10-15T10:00:00Z") });
    expect(path).toBe(join(dir, "yt-dlp"));
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(downloads).toEqual([
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS",
    ]);

    // The stamp file has the time of the last check.
    const stamp = join(dir, "yt-dlp.updated");
    utimesSync(stamp, new Date("2026-10-15T10:00:00Z"), new Date("2026-10-15T10:00:00Z"));
    await ensureYtDlp({ ...options, now: new Date("2026-10-15T20:00:00Z") });
    expect(runs).toEqual([]);
    await ensureYtDlp({ ...options, now: new Date("2026-10-16T11:00:00Z") });
    expect(runs).toEqual([["--update"]]);
    expect(lines.at(-1)).toBe("yt-dlp: yt-dlp is up to date (2026.08.19)");
    expect(downloads).toHaveLength(2);
  });

  it("does not keep a download with a wrong checksum", async () => {
    const dir = tempDir();
    const download = async (url: string) => (url.endsWith("SHA2-256SUMS") ? sums(new TextEncoder().encode("other")) : program);
    await expect(ensureYtDlp({ dir, platform: "linux", arch: "x64", download })).rejects.toThrow(/checksum/);
    expect(existsSync(join(dir, "yt-dlp"))).toBe(false);
  });
});

describe("transcripts", () => {
  it("splits the answer at the times, keeps code blocks, and removes headings", () => {
    const text = `Welcome.
## Intro
[0:06] I start here.
More words.
\`\`\`ts
[0:30] not a time in code
## not a heading in code
\`\`\`
[1:04:05] Late text.`;
    expect(parseTranscript(text)).toEqual([
      { start: 0, markdown: "Welcome." },
      { start: 6, markdown: "I start here.\nMore words.\n```ts\n[0:30] not a time in code\n## not a heading in code\n```" },
      { start: 3845, markdown: "Late text." },
    ]);
  });

  const paragraphs = (...starts: number[]) => starts.map((start) => ({ start, markdown: "Text." }));

  it("accepts a full transcript, and a time that is a few seconds too early", () => {
    expect(checkTranscript(paragraphs(0, 40, 37, 200, 350, 500, 650), 721, "stop")).toBeNull();
  });

  it("finds a transcript that is not complete", () => {
    expect(checkTranscript(paragraphs(0, 40), 721, "length")).toMatch(/token limit/);
    expect(checkTranscript([], 721, "stop")).toMatch(/no paragraphs/);
    expect(checkTranscript(paragraphs(0, 150, 300, 200, 350, 500, 650), 721, "stop")).toMatch(/3:20 comes after 5:00/);
    expect(checkTranscript(paragraphs(0, 100, 400, 700), 721, "stop")).toMatch(/no text from 1:40 to 6:40/);
    expect(checkTranscript(paragraphs(0, 100, 200, 300), 721, "stop")).toMatch(/stops at 5:00/);
    expect(checkTranscript(paragraphs(0, 100, 200, 800), 721, "stop")).toMatch(/after the end/);
  });

  it("puts a note before each code block and each table", () => {
    const markdown = "First we type this.\n```ts\nlet a = 1;\n```\nThen the table.\n| A | B |\n|---|---|\n| 1 | 2 |\nEnd.";
    expect(addNotes(markdown)).toBe(
      `First we type this.\n\n${CODE_NOTE}\n\n\`\`\`ts\nlet a = 1;\n\`\`\`\nThen the table.\n\n${TABLE_NOTE}\n\n| A | B |\n|---|---|\n| 1 | 2 |\nEnd.`,
    );
    expect(addNotes("Only speech | with a pipe.")).toBe("Only speech | with a pipe.");
  });

  it("gives more output tokens to a longer video, up to the limit of the model", () => {
    expect(maxTokensFor(721)).toBe(1000 + 13 * 700);
    expect(maxTokensFor(10 * 3600)).toBe(65_536);
  });
});

// A fake video model: one answer for each call, in order, for each video address.
function fakeClient(answers: Record<string, (Partial<TranscribeResult> & { text: string })[]>): VideoClient & { calls: TranscribeRequest[] } {
  const calls: TranscribeRequest[] = [];
  return {
    calls,
    async transcribe(request) {
      calls.push(request);
      const answer = answers[request.url]?.shift();
      if (!answer) throw new Error(`No answer for ${request.url}`);
      return { finishReason: "stop", inputTokens: 1000, outputTokens: 100, cost: 0.01, ...answer };
    },
  };
}

const video = (id: string, title: string, duration: number, chapters: VideoFacts["chapters"] = []): VideoFacts => ({
  id,
  title,
  channel: "Teacher",
  duration,
  chapters,
  language: "en",
});

describe("fetchVideos", () => {
  const one = video("aaaaaaaaaaa", "TypeScript Basics", 600, [
    { title: "Intro", start: 0, end: 20 },
    { title: "Types", start: 20, end: 300 },
    { title: "Generics", start: 300, end: 600 },
  ]);
  const oneText = `[0:00] Music.
[0:30] A **type annotation** tells the compiler the type. ${prose("type", 60)}
\`\`\`ts
let lucky: number = 23;
\`\`\`
[2:00] ${prose("more", 50)}
[4:00] ${prose("more2", 50)}
[5:10] ${prose("generic", 60)}
[7:00] ${prose("generic2", 40)}
[9:00] ${prose("end", 20)}`;

  it("writes one chapter for each YouTube chapter of one video, with time links and notes", async () => {
    const client = fakeClient({ "https://www.youtube.com/watch?v=aaaaaaaaaaa": [{ text: oneText }] });
    const result = await fetchVideos({
      kind: "video",
      title: one.title,
      channel: "Teacher",
      source: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      videos: [one],
      client,
      model: "openrouter google/gemini-test",
      cacheDir: tempDir(),
      date: new Date("2026-10-15T12:00:00Z"),
    });
    expect(result.requests).toBe(1);
    expect(result.cost).toBeCloseTo(0.01);
    expect(client.calls[0]!.maxTokens).toBe(1000 + 10 * 700);
    expect(client.calls[0]!.prompt).toContain("The video is 10:00 long.");

    const book = await parseBook(result.epub, "typescript-basics.epub");
    expect(book.title).toBe("TypeScript Basics");
    expect(book.authors).toEqual(["Teacher"]);
    expect(book.warnings).toEqual([]);
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["Intro", "Types", "Generics"]);
    const types = book.chapters[1]!.sections[0]!.markdown;
    expect(types).toContain("[0:30](https://www.youtube.com/watch?v=aaaaaaaaaaa&t=30s) A **type annotation** tells");
    expect(types).toContain("_The tutor read this code from the video:_");
    expect(types).toContain("let lucky: number = 23;");
    expect(book.chapters[1]!.checklist).toContainEqual(expect.objectContaining({ term: "type annotation", source: "bold" }));
    expect(book.chapters[2]!.sections[0]!.markdown).toContain("[9:00](https://www.youtube.com/watch?v=aaaaaaaaaaa&t=540s)");
  });

  it("leaves out a YouTube chapter with no paragraph", async () => {
    const short = video("aaaaaaaaaaa", "Short", 600, [
      { title: "Intro", start: 0, end: 20 },
      { title: "Empty", start: 20, end: 25 },
      { title: "Main", start: 25, end: 600 },
    ]);
    const text = `[0:00] ${prose("intro", 50)}\n[0:40] ${prose("main", 50)}\n[2:30] ${prose("a", 50)}\n[5:00] ${prose("b", 50)}\n[7:30] ${prose("c", 50)}\n[9:30] ${prose("d", 50)}`;
    const client = fakeClient({ "https://www.youtube.com/watch?v=aaaaaaaaaaa": [{ text }] });
    const result = await fetchVideos({ kind: "video", title: "Short", channel: "T", source: "s", videos: [short], client, model: "m", cacheDir: tempDir() });
    const book = await parseBook(result.epub, "short.epub");
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["Intro", "Main"]);
  });

  it("writes one chapter for each video of a playlist, with the YouTube chapters as sections", async () => {
    const first = video("aaaaaaaaaaa", "Lesson 1", 240, [
      { title: "Setup", start: 0, end: 120 },
      { title: "First query", start: 120, end: 240 },
    ]);
    const second = video("bbbbbbbbbbb", "Lesson 2", 200);
    const client = fakeClient({
      "https://www.youtube.com/watch?v=aaaaaaaaaaa": [{ text: `[0:00] ${prose("setup", 60)}\n[2:10] ${prose("query", 60)}` }],
      "https://www.youtube.com/watch?v=bbbbbbbbbbb": [{ text: `[0:00] ${prose("join", 60)}\n[2:00] ${prose("join2", 60)}` }],
    });
    const result = await fetchVideos({
      kind: "playlist",
      title: "SQL Course",
      channel: "Teacher",
      source: "https://www.youtube.com/playlist?list=PLabcdefghij12",
      videos: [first, second],
      client,
      model: "m",
      cacheDir: tempDir(),
    });
    expect(result.videos).toBe(2);
    const book = await parseBook(result.epub, "sql-course.epub");
    expect(book.chapters.map((chapter) => [chapter.title, chapter.sections.map((section) => section.title)])).toEqual([
      ["Lesson 1", ["Setup", "First query"]],
      ["Lesson 2", ["Lesson 2"]],
    ]);
  });

  it("tries a second time after a transcript that is not complete, and skips the video after two", async () => {
    const good = video("aaaaaaaaaaa", "Good", 200);
    const bad = video("bbbbbbbbbbb", "Bad", 200);
    const full = `[0:00] ${prose("a", 60)}\n[1:40] ${prose("b", 60)}`;
    const client = fakeClient({
      "https://www.youtube.com/watch?v=aaaaaaaaaaa": [{ text: "[0:00] Cut.", finishReason: "length" }, { text: full }],
      "https://www.youtube.com/watch?v=bbbbbbbbbbb": [{ text: "[0:00] Only the start." }, { text: "[0:00] Only the start again." }],
    });
    const lines: string[] = [];
    const result = await fetchVideos({
      kind: "playlist",
      title: "Course",
      channel: "T",
      source: "s",
      videos: [good, bad],
      client,
      model: "m",
      cacheDir: tempDir(),
      log: (line) => lines.push(line),
    });
    expect(result.requests).toBe(4);
    expect(result.videos).toBe(1);
    expect(result.skipped).toEqual([{ url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", reason: "the transcript stops at 0:00, but the video is 3:20 long" }]);
    expect(lines).toContain("  The transcript is not complete: the transcript reached the token limit. Trying again.");

    const none = fakeClient({ "https://www.youtube.com/watch?v=bbbbbbbbbbb": [{ text: "[0:00] Cut." }, { text: "[0:00] Cut." }] });
    await expect(
      fetchVideos({ kind: "video", title: "Bad", channel: "T", source: "s", videos: [bad], client: none, model: "m", cacheDir: tempDir() }),
    ).rejects.toThrow(/writes no EPUB file/);
  });

  it("uses the cache, so a second run makes no request", async () => {
    const cacheDir = tempDir();
    const options = { kind: "video" as const, title: one.title, channel: "T", source: "s", videos: [one], model: "m", cacheDir };
    await fetchVideos({ ...options, client: fakeClient({ "https://www.youtube.com/watch?v=aaaaaaaaaaa": [{ text: oneText }] }) });
    expect(existsSync(join(cacheDir, "aaaaaaaaaaa.json"))).toBe(true);
    const client = fakeClient({});
    const result = await fetchVideos({ ...options, client });
    expect(client.calls).toEqual([]);
    expect(result.requests).toBe(0);
    expect(result.cost).toBeNull();
  });

  it("puts each paragraph into the part that holds the larger share of its time", () => {
    const parts = [
      { title: "A", start: 10, end: 60 },
      { title: "B", start: 60, end: 120 },
    ];
    // "y" lasts from 0:50 to 1:30: 10 seconds in A and 30 seconds in B. "w" lasts from 0:30 to 0:50, in A only.
    const paragraphs = [
      { start: 0, markdown: "x" },
      { start: 30, markdown: "w" },
      { start: 50, markdown: "y" },
      { start: 90, markdown: "z" },
    ];
    const groups = splitByParts(paragraphs, parts, 120);
    expect(groups.map((group) => group.map((paragraph) => paragraph.markdown))).toEqual([["x", "w"], ["y", "z"]]);
  });

  it("names a book with some videos of a playlist after the videos", () => {
    expect(playlistBookTitle("Course", 5, [1, 2, 3, 4, 5], [])).toBe("Course");
    expect(playlistBookTitle("Course", 5, [2, 4], ["Joins", "Views"])).toBe("Course - Joins, Views");
    expect(playlistBookTitle("Course", 9, [1, 2, 3, 7], [])).toBe("Course - videos 1-3, 7");
  });
});

describe("video clients", () => {
  const request = { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", prompt: "Write a transcript.", maxTokens: 8000 };

  it("sends the YouTube address to OpenRouter in a video_url part", async () => {
    let params: Record<string, unknown> | undefined;
    const sdk = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            params = body;
            return {
              choices: [{ message: { content: "[0:00] Hello." }, finish_reason: "stop" }],
              usage: { prompt_tokens: 65881, completion_tokens: 6314, cost: 0.073 },
            };
          },
        },
      },
    };
    const config: VideoConfig = { provider: "openrouter", model: "google/gemini-3.8-flash", apiKey: "key" };
    const client = new OpenRouterVideoClient(config, sdk as unknown as ConstructorParameters<typeof OpenRouterVideoClient>[1]);
    const result = await client.transcribe(request);
    expect(params).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 8000,
      reasoning: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Write a transcript." },
            { type: "video_url", video_url: { url: request.url, processing: "static" } },
          ],
        },
      ],
    });
    expect(result).toEqual({ text: "[0:00] Hello.", finishReason: "stop", inputTokens: 65881, outputTokens: 6314, cost: 0.073 });
  });

  const gemini = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { calls, fetcher: fetcher as typeof fetch };
  };
  const config: VideoConfig = { provider: "google", model: "gemini-3.8-flash", apiKey: "gemini-key" };

  it("sends the YouTube address to the Interactions API of Gemini in a video part", async () => {
    const { calls, fetcher } = gemini(200, {
      status: "completed",
      steps: [
        { type: "thought", content: [] },
        { type: "model_output", content: [{ type: "text", text: "[0:00] Hello" }, { type: "text", text: " there." }] },
      ],
      usage: { total_input_tokens: 70000, total_output_tokens: 6000, total_thought_tokens: 100 },
    });
    const result = await new GeminiVideoClient(config, fetcher).transcribe(request);
    expect(calls[0]!.url).toBe(GEMINI_INTERACTIONS_URL);
    expect(calls[0]!.init.headers).toMatchObject({ "x-goog-api-key": "gemini-key" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gemini-3.8-flash",
      input: [
        { type: "text", text: "Write a transcript." },
        { type: "video", uri: request.url, processing: "static" },
      ],
      generation_config: { max_output_tokens: 8000, thinking_level: "low" },
      store: false,
    });
    expect(result).toEqual({ text: "[0:00] Hello there.", finishReason: "stop", inputTokens: 70000, outputTokens: 6100, cost: null });
  });

  it("gives the finish reason length for an incomplete answer, and a clear error for a limit", async () => {
    const incomplete = gemini(200, { status: "incomplete", steps: [{ type: "model_output", content: [{ type: "text", text: "[0:00] Cut" }] }] });
    expect((await new GeminiVideoClient(config, incomplete.fetcher).transcribe(request)).finishReason).toBe("length");
    const limited = gemini(429, { error: { message: "Quota exceeded." } });
    const error = await new GeminiVideoClient(config, limited.fetcher).transcribe(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as Error).message).toMatch(/daily limit is reached.*Quota exceeded/);
  });

  it("reads the prices of OpenRouter and estimates the cost of a video", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ data: [{ id: "google/gemini-3.8-flash", pricing: { prompt: "0.00000075", completion: "0.00000375" } }] }))) as typeof fetch;
    const prices = await openRouterPrices("google/gemini-3.8-flash", fetcher);
    expect(prices).toEqual({ input: 0.00000075, output: 0.00000375 });
    expect(await openRouterPrices("other/model", fetcher)).toBeNull();
    // The 12-minute test video cost $0.073.
    expect(estimateCost(721, prices!)).toBeCloseTo(0.079, 2);
  });
});

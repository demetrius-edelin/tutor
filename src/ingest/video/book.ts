import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEpub, type EpubChapter, type EpubPage } from "../web/epub.js";
import { FetchStopped, formatList, type FetchProgress } from "../web/fetch.js";
import { cleanMarkdownPage } from "../web/page.js";
import type { VideoClient } from "./client.js";
import { checkTranscript, maxTokensFor, paragraphMarkdown, parseTranscript, transcriptPrompt, type TranscriptParagraph } from "./transcript.js";
import { formatLength, videoUrl, type VideoChapter, type VideoFacts } from "./youtube.js";

// A YouTube video or playlist becomes an EPUB file, as an online book does.
// - One video: each YouTube chapter is a chapter of the book.
// - A playlist: each video is a chapter, and the YouTube chapters of a video are its sections.
// - A video with no YouTube chapters is one chapter. The parser splits it into sections by size.

export interface FetchVideosOptions {
  kind: "video" | "playlist";
  title: string;
  channel: string;
  // The address of the video or of the playlist.
  source: string;
  // The videos to transcribe, in book order.
  videos: VideoFacts[];
  client: VideoClient;
  // The name of the video model, for the cache files.
  model: string;
  // The folder of the transcripts, for example "data/web/transcripts".
  cacheDir: string;
  date?: Date;
  log?: (line: string) => void;
  // Called before each video and before the EPUB file. A step is one video.
  progress?: (progress: FetchProgress) => void;
  // True if the user stopped the download. Then fetchVideos ends with FetchStopped before the next video.
  // The finished transcripts stay in the cache.
  stopped?: () => boolean;
}

export interface FetchVideosResult {
  title: string;
  epub: Uint8Array;
  videos: number;
  words: number;
  // The model requests, and their cost in dollars if the provider gives it.
  requests: number;
  cost: number | null;
  // The videos with no transcript, with the reason.
  skipped: { url: string; reason: string }[];
}

interface CachedTranscript {
  id: string;
  title: string;
  model: string;
  date: string;
  duration: number;
  text: string;
}

// The title of a book with some videos of a playlist. Two selections of the same playlist must give two titles,
// because the title gives the file name and the folder of the book in a subject.
export function playlistBookTitle(title: string, count: number, selected: number[], names: string[]): string {
  if (selected.length === count) return title;
  if (selected.length <= 3) return `${title} - ${names.join(", ")}`;
  return `${title} - videos ${formatList(selected)}`;
}

const cacheFile = (dir: string, id: string) => join(dir, `${id}.json`);

// A transcript from the cache, if it still passes the checks.
function cachedParagraphs(dir: string, video: VideoFacts): TranscriptParagraph[] | null {
  const file = cacheFile(dir, video.id);
  if (!existsSync(file)) return null;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CachedTranscript;
    const paragraphs = parseTranscript(cached.text);
    return checkTranscript(paragraphs, video.duration, "stop") === null ? paragraphs : null;
  } catch {
    return null;
  }
}

// The paragraphs of each part. A paragraph lasts until the next paragraph starts, and it goes into the part that holds
// the larger share of its time. A paragraph often starts some seconds before a YouTube chapter, with the first words
// of that chapter. The first part also takes the time before it, and the last part the time after it.
export function splitByParts(paragraphs: TranscriptParagraph[], parts: VideoChapter[], seconds: number): TranscriptParagraph[][] {
  const groups = parts.map((): TranscriptParagraph[] => []);
  paragraphs.forEach((paragraph, i) => {
    const start = paragraph.start;
    const end = Math.max(paragraphs[i + 1]?.start ?? seconds, start + 1);
    let best = 0;
    let bestShare = -1;
    parts.forEach((part, p) => {
      const partStart = p === 0 ? -Infinity : part.start;
      const partEnd = p === parts.length - 1 ? Infinity : parts[p + 1]!.start;
      const share = Math.min(end, partEnd) - Math.max(start, partStart);
      if (share > bestShare) {
        best = p;
        bestShare = share;
      }
    });
    groups[best]!.push(paragraph);
  });
  return groups;
}

export async function fetchVideos(options: FetchVideosOptions): Promise<FetchVideosResult> {
  const log = options.log ?? (() => {});
  const progress = options.progress ?? (() => {});
  const count = options.videos.length;
  const skipped: FetchVideosResult["skipped"] = [];
  const transcripts = new Map<string, TranscriptParagraph[]>();
  let requests = 0;
  let cost: number | null = null;

  for (const [i, video] of options.videos.entries()) {
    if (options.stopped?.()) throw new FetchStopped();
    progress({ text: `Transcribing video ${i + 1} of ${count}, "${video.title}".`, done: i, total: count });
    log(`[${i + 1}/${count}] ${video.title} (${formatLength(video.duration)})`);
    const cached = cachedParagraphs(options.cacheDir, video);
    if (cached) {
      log("  From the cache.");
      transcripts.set(video.id, cached);
      continue;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const start = Date.now();
      const result = await options.client.transcribe({
        url: videoUrl(video.id),
        prompt: transcriptPrompt(video.duration),
        maxTokens: maxTokensFor(video.duration),
      });
      requests++;
      if (result.cost !== null) cost = (cost ?? 0) + result.cost;
      const price = result.cost !== null ? `, $${result.cost.toFixed(3)}` : "";
      log(`  ${((Date.now() - start) / 1000).toFixed(0)} s, ${result.inputTokens} input tokens, ${result.outputTokens} output tokens${price}.`);
      const paragraphs = parseTranscript(result.text);
      const problem = checkTranscript(paragraphs, video.duration, result.finishReason);
      if (!problem) {
        mkdirSync(options.cacheDir, { recursive: true });
        const entry: CachedTranscript = {
          id: video.id,
          title: video.title,
          model: options.model,
          date: (options.date ?? new Date()).toISOString(),
          duration: video.duration,
          text: result.text,
        };
        writeFileSync(cacheFile(options.cacheDir, video.id), `${JSON.stringify(entry, null, 2)}\n`);
        transcripts.set(video.id, paragraphs);
        break;
      }
      log(`  The transcript is not complete: ${problem}.${attempt === 1 ? " Trying again." : ""}`);
      if (attempt === 2) skipped.push({ url: videoUrl(video.id), reason: problem });
    }
  }

  let words = 0;
  const page = (video: VideoFacts, id: string, heading: string | null, paragraphs: TranscriptParagraph[]): EpubPage => {
    const markdown = paragraphs.map((paragraph) => paragraphMarkdown(video.id, paragraph)).join("\n\n");
    const clean = cleanMarkdownPage(markdown, videoUrl(video.id), { prefix: id, titles: [], headingBase: 3 });
    words += clean.words;
    return { id, heading, xhtml: clean.render(new Map()) };
  };
  const wholeVideo = (video: VideoFacts): VideoChapter[] => [{ title: video.title, start: 0, end: video.duration }];

  const chapters: EpubChapter[] = [];
  for (const [v, video] of options.videos.entries()) {
    const paragraphs = transcripts.get(video.id);
    if (!paragraphs) continue;
    const parts = video.chapters.length > 0 ? video.chapters : wholeVideo(video);
    const groups = splitByParts(paragraphs, parts, video.duration);
    if (options.kind === "video") {
      // Each YouTube chapter is a chapter of the book. A part with no speech, for example a short intro with music, goes.
      parts.forEach((part, p) => {
        if (groups[p]!.length > 0) chapters.push({ title: part.title, pages: [page(video, `v${v + 1}c${p + 1}`, null, groups[p]!)] });
      });
    } else {
      const heading = (p: number) => (video.chapters.length > 0 ? parts[p]!.title : null);
      const pages = parts.flatMap((_, p) => (groups[p]!.length > 0 ? [page(video, `v${v + 1}c${p + 1}`, heading(p), groups[p]!)] : []));
      chapters.push({ title: video.title, pages });
    }
  }
  if (chapters.length === 0) throw new Error("No video has a complete transcript, so the tutor writes no EPUB file.");
  if (options.stopped?.()) throw new FetchStopped();
  progress({ text: "Writing the EPUB file.", done: count, total: count });

  const epub = await writeEpub({
    title: options.title,
    author: options.channel,
    language: options.videos.find((video) => video.language)?.language ?? "en",
    source: options.source,
    date: options.date ?? new Date(),
    chapters,
    images: [],
  });
  return { title: options.title, epub, videos: transcripts.size, words, requests, cost, skipped };
}

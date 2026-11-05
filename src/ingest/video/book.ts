import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VideoTier } from "../../config.js";
import { writeEpub, type EpubChapter, type EpubPage } from "../web/epub.js";
import { FetchStopped, formatList, type FetchProgress } from "../web/fetch.js";
import { cleanMarkdownPage } from "../web/page.js";
import { CLIP_SECONDS, clipProblem, inParallel, joinTranscripts, planClips } from "./clips.js";
import type { Clip, TranscribeResult, VideoClient } from "./client.js";
import { checkTranscript, maxTokensFor, paragraphMarkdown, parseTranscript, transcriptPrompt, type TranscriptParagraph } from "./transcript.js";
import { formatLength, formatTime, videoUrl, type VideoChapter, type VideoFacts } from "./youtube.js";

// A YouTube video or playlist becomes an EPUB file, as an online book does.
// - A short video: the video is one chapter, and its YouTube chapters are its sections. Then ingest reads the full video
//   in one request, and does not find the same idea again in each small chapter.
// - A long video: each YouTube chapter is a chapter of the book.
// - A long video with no YouTube chapters: each part of at most 30 minutes is a chapter, so that the user can select
//   some parts of a long lecture.
// - A playlist: each video is a chapter, and the YouTube chapters of a video are its sections.
// - A short video with no YouTube chapters is one chapter. The parser splits it into sections by size.

// The longest video that becomes one chapter.
export const ONE_CHAPTER_SECONDS = 30 * 60;

// The clips of a long video that go to the video model at the same time. More requests at the same time can reach the
// token limit of the provider for each minute.
const PARALLEL_CLIPS = 3;
// A Flex request waited 1.5 to more than 5 minutes in a queue in the tests. After the queue and the work, the tutor
// stops it and sends the request again in the tier Standard. The video model needs about 4 seconds for each minute of
// video, so the limit for the work has a margin.
const FLEX_QUEUE_MS = 8 * 60 * 1000;
const FLEX_WORK_MS_PER_MINUTE = 8 * 1000;

export interface FetchVideosOptions {
  kind: "video" | "playlist";
  title: string;
  channel: string;
  // The address of the video or of the playlist.
  source: string;
  // The videos to transcribe, in book order.
  videos: VideoFacts[];
  client: VideoClient;
  // True if the video model takes clips: the Gemini API of Google. Then a video that is longer than CLIP_SECONDS goes
  // to the model in clips.
  clips?: boolean;
  // The tier of the first request for each transcript. The default is Standard. A Flex request that fails or takes too
  // long goes again to the tier Standard.
  tier?: VideoTier;
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

interface CachedClip {
  id: string;
  model: string;
  date: string;
  clip: Clip;
  text: string;
}

const cacheFile = (dir: string, id: string) => join(dir, `${id}.json`);
// The cache keeps the transcript of each clip until the transcript of the full video is complete. Thus after a failure
// or a stop, the next run does not pay for the finished clips again.
const clipDir = (dir: string, id: string) => join(dir, "clips", id);
const clipFile = (dir: string, id: string, clip: Clip) => join(clipDir(dir, id), `${clip.start}-${clip.end}.json`);

function cachedClip(dir: string, id: string, clip: Clip): string | null {
  const file = clipFile(dir, id, clip);
  if (!existsSync(file)) return null;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CachedClip;
    return clipProblem(cached.text, clip, "stop") === null ? cached.text : null;
  } catch {
    return null;
  }
}

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

// The parts of a long video with no YouTube chapters: equal parts of at most ONE_CHAPTER_SECONDS, each with its times
// in the title, for example "Part 2 (30:00 to 1:00:00)".
export function timeParts(duration: number): VideoChapter[] {
  const count = Math.max(1, Math.ceil(duration / ONE_CHAPTER_SECONDS));
  const length = duration / count;
  return Array.from({ length: count }, (_, i) => {
    const start = Math.round(i * length);
    const end = i === count - 1 ? duration : Math.round((i + 1) * length);
    return { title: `Part ${i + 1} (${formatTime(start)} to ${formatTime(end)})`, start, end };
  });
}

// The model requests of a run, and their cost in dollars if the provider gives it.
interface Usage {
  requests: number;
  cost: number | null;
}

// A transcript, or the reason why there is no complete transcript.
type Outcome = { text: string } | { problem: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// One request for the full video or for one clip. A Flex request that fails or takes too long goes again to the tier
// Standard. `label` names the clip in the log.
async function transcribeOnce(options: FetchVideosOptions, video: VideoFacts, clip: Clip | null, tier: VideoTier, usage: Usage, label: string) {
  const log = options.log ?? (() => {});
  const seconds = clip ? clip.end - clip.start : video.duration;
  const request = { url: videoUrl(video.id), prompt: transcriptPrompt(seconds), maxTokens: maxTokensFor(seconds), ...(clip ? { clip } : {}) };
  const send = async (extra: { tier?: VideoTier; timeoutMs?: number }): Promise<TranscribeResult> => {
    const start = Date.now();
    usage.requests++;
    const result = await options.client.transcribe({ ...request, ...extra });
    if (result.cost !== null) usage.cost = (usage.cost ?? 0) + result.cost;
    const price = result.cost !== null ? `, $${result.cost.toFixed(3)}` : "";
    const served = result.tier === "flex" ? ", tier Flex" : "";
    log(`  ${label}${((Date.now() - start) / 1000).toFixed(0)} s, ${result.inputTokens} input tokens, ${result.outputTokens} output tokens${price}${served}.`);
    return result;
  };
  if (tier === "flex") {
    try {
      return await send({ tier, timeoutMs: Math.round(FLEX_QUEUE_MS + (seconds / 60) * FLEX_WORK_MS_PER_MINUTE) });
    } catch (error) {
      log(`  ${label}The Flex request failed: ${message(error)} Trying the tier Standard.`);
    }
  }
  return send({});
}

// The transcript of the full video or of one clip. After a transcript that is not complete, the model gets a second
// try in the tier Standard, because the user waited already.
async function partTranscript(options: FetchVideosOptions, video: VideoFacts, clip: Clip | null, usage: Usage, label: string): Promise<Outcome> {
  const log = options.log ?? (() => {});
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tier = attempt === 1 ? (options.tier ?? "standard") : "standard";
    const result = await transcribeOnce(options, video, clip, tier, usage, label);
    problem =
      (clip
        ? clipProblem(result.text, clip, result.finishReason)
        : checkTranscript(parseTranscript(result.text), video.duration, result.finishReason)) ?? "";
    if (!problem) return { text: result.text };
    log(`  ${label}The transcript is not complete: ${problem}.${attempt === 1 ? " Trying again." : ""}`);
  }
  return { problem };
}

// The transcript of one video. A video that is longer than one clip goes to the model in clips, at most PARALLEL_CLIPS
// at the same time, if the video model takes clips. The join of the clips removes the overlaps. A clip that is not
// complete after two tries gives no transcript for the video, but the other clips stay in the cache.
async function videoTranscript(
  options: FetchVideosOptions,
  video: VideoFacts,
  usage: Usage,
  onClip: (ready: number, total: number) => void,
): Promise<Outcome> {
  const clips = options.clips && video.duration > CLIP_SECONDS ? planClips(video.duration) : null;
  if (!clips) return partTranscript(options, video, null, usage, "");
  const log = options.log ?? (() => {});
  log(`  ${clips.length} clips of about ${formatLength(Math.round(video.duration / clips.length))}, at most ${PARALLEL_CLIPS} at the same time.`);
  let ready = 0;
  onClip(ready, clips.length);
  const names = clips.map((clip, i) => `clip ${i + 1} of ${clips.length} (${formatTime(clip.start)} to ${formatTime(clip.end)})`);
  const parts = await inParallel(
    clips.map((clip, i) => ({ clip, i })),
    PARALLEL_CLIPS,
    async ({ clip, i }): Promise<Outcome> => {
      const label = `${names[i]!.charAt(0).toUpperCase()}${names[i]!.slice(1)}: `;
      const cached = cachedClip(options.cacheDir, video.id, clip);
      let part: Outcome;
      if (cached) {
        log(`  ${label}From the cache.`);
        part = { text: cached };
      } else {
        // The clips that run now finish, and the cache keeps them.
        if (options.stopped?.()) throw new FetchStopped();
        part = await partTranscript(options, video, clip, usage, label);
        if ("text" in part) {
          mkdirSync(clipDir(options.cacheDir, video.id), { recursive: true });
          const entry: CachedClip = { id: video.id, model: options.model, date: (options.date ?? new Date()).toISOString(), clip, text: part.text };
          writeFileSync(clipFile(options.cacheDir, video.id, clip), `${JSON.stringify(entry, null, 2)}\n`);
        }
      }
      onClip(++ready, clips.length);
      return part;
    },
  );
  const failed = parts.findIndex((part) => "problem" in part);
  if (failed >= 0) return { problem: `${names[failed]!}: ${(parts[failed] as { problem: string }).problem}` };

  let text = (parts[0] as { text: string }).text;
  for (let i = 1; i < parts.length; i++) {
    const joined = joinTranscripts(text, (parts[i] as { text: string }).text, { start: clips[i]!.start, end: clips[i - 1]!.end });
    log(`  The join of clips ${i} and ${i + 1} is at ${formatTime(joined.join.at)}${joined.join.method === "time" ? ", by time, because the clips have no sentence in common" : ""}.`);
    text = joined.text;
  }
  // Each clip passed its checks, but a wrong join can still leave a gap. Then the clips stay in the cache.
  const problem = checkTranscript(parseTranscript(text), video.duration, "stop");
  return problem ? { problem: `the joined transcript is not complete: ${problem}` } : { text };
}

export async function fetchVideos(options: FetchVideosOptions): Promise<FetchVideosResult> {
  const log = options.log ?? (() => {});
  const progress = options.progress ?? (() => {});
  const count = options.videos.length;
  const skipped: FetchVideosResult["skipped"] = [];
  const transcripts = new Map<string, TranscriptParagraph[]>();
  const usage: Usage = { requests: 0, cost: null };

  for (const [i, video] of options.videos.entries()) {
    if (options.stopped?.()) throw new FetchStopped();
    const step = `Transcribing video ${i + 1} of ${count}, "${video.title}"`;
    progress({ text: `${step}.`, done: i, total: count });
    log(`[${i + 1}/${count}] ${video.title} (${formatLength(video.duration)})`);
    const cached = cachedParagraphs(options.cacheDir, video);
    if (cached) {
      log("  From the cache.");
      transcripts.set(video.id, cached);
      continue;
    }
    const outcome = await videoTranscript(options, video, usage, (ready, total) =>
      progress({ text: `${step}: ${ready} of ${total} clips are ready.`, done: i, total: count }),
    );
    if ("problem" in outcome) {
      skipped.push({ url: videoUrl(video.id), reason: outcome.problem });
      continue;
    }
    mkdirSync(options.cacheDir, { recursive: true });
    const entry: CachedTranscript = {
      id: video.id,
      title: video.title,
      model: options.model,
      date: (options.date ?? new Date()).toISOString(),
      duration: video.duration,
      text: outcome.text,
    };
    writeFileSync(cacheFile(options.cacheDir, video.id), `${JSON.stringify(entry, null, 2)}\n`);
    rmSync(clipDir(options.cacheDir, video.id), { recursive: true, force: true });
    transcripts.set(video.id, parseTranscript(outcome.text));
  }
  const { requests, cost } = usage;

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
    const long = options.kind === "video" && video.duration > ONE_CHAPTER_SECONDS;
    const parts = video.chapters.length > 0 ? video.chapters : long ? timeParts(video.duration) : wholeVideo(video);
    const groups = splitByParts(paragraphs, parts, video.duration);
    if (long) {
      // Each YouTube chapter or time part is a chapter of the book. A part with no speech, for example a short intro
      // with music, goes.
      parts.forEach((part, p) => {
        if (groups[p]!.length > 0) chapters.push({ title: part.title, pages: [page(video, `v${v + 1}c${p + 1}`, null, groups[p]!)] });
      });
    } else {
      // A short video, or a video of a playlist, is one chapter. Its YouTube chapters are the sections.
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

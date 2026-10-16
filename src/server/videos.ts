import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { describeVideoModel, type VideoConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { fetchVideos, ONE_CHAPTER_SECONDS, playlistBookTitle } from "../ingest/video/book.js";
import { estimateCost, type ModelPrices, type VideoClient } from "../ingest/video/client.js";
import { MAX_VIDEO_SECONDS } from "../ingest/video/transcript.js";
import { readPlaylist, readVideo, type YtDlpRunner } from "../ingest/video/ytdlp.js";
import { formatLength, parseYoutubeUrl, playlistUrl, videoUrl, type VideoFacts } from "../ingest/video/youtube.js";
import { FetchStopped } from "../ingest/web/fetch.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { FetchStartView, VideoToc } from "./api-types.js";
import { startDownload, type DownloadPlan } from "./downloads.js";
import type { BookLocation } from "./ingests.js";

// YouTube videos in the app. yt-dlp reads the facts of a video or of a playlist, and the video model writes the transcripts.
// The download is a run with the mode "fetch", as for an online book. Each video is one step.

export interface VideoAccess {
  // The video model from .env, or null. Then error tells why.
  config: VideoConfig | null;
  error: string | null;
  // The yt-dlp program. At the first use, the tutor downloads it into data/bin/.
  ytDlp: () => Promise<YtDlpRunner>;
  client: (config: VideoConfig) => VideoClient;
  // The prices of a model in the public model list of OpenRouter, for the cost estimate.
  prices: (model: string) => Promise<ModelPrices | null>;
  log?: (line: string) => void;
}

const NO_VIDEO_MODEL = "Videos need a video model. In .env, set VIDEO_PROVIDER to openrouter or google, and set VIDEO_MODEL.";
const LIMIT = `The tutor transcribes videos of up to ${MAX_VIDEO_SECONDS / 60} minutes, because a longer transcript does not fit into the answer of the model.`;
const tooLong = (seconds: number | null) => seconds !== null && seconds > MAX_VIDEO_SECONDS;
const transcriptsDir = (dataDir: string) => join(dataDir, "web", "transcripts");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function ytDlp(video: VideoAccess): Promise<YtDlpRunner> {
  try {
    return await video.ytDlp();
  } catch (error) {
    throw new TutorError(`The tutor cannot install yt-dlp: ${message(error)}`, 502);
  }
}

// The cost of one second of video, or the note that tells why there is no estimate.
async function costRate(video: VideoAccess): Promise<Pick<VideoToc, "dollarsPerSecond" | "costNote">> {
  const config = video.config;
  if (!config) return { dollarsPerSecond: null, costNote: null };
  if (config.provider === "google") {
    return { dollarsPerSecond: null, costNote: "No cost estimate for the Gemini API of Google. Its free tier allows 8 hours of YouTube video a day." };
  }
  const prices = await video.prices(config.model);
  return prices
    ? { dollarsPerSecond: estimateCost(1, prices), costNote: null }
    : { dollarsPerSecond: null, costNote: `No cost estimate: the model list of OpenRouter does not have "${config.model}".` };
}

// The facts of a YouTube video or playlist. They need no video model, so the app shows them also with no video model.
export async function findVideoToc(video: VideoAccess, dataDir: string, url: string): Promise<VideoToc> {
  const target = parseYoutubeUrl(url);
  if (!target) throw new TutorError(`"${url}" is not the address of a YouTube video or playlist.`);
  const run = await ytDlp(video);
  const cached = (id: string) => existsSync(join(transcriptsDir(dataDir), `${id}.json`));
  const model = {
    model: video.config ? describeVideoModel(video.config) : null,
    modelError: video.config ? null : (video.error ?? NO_VIDEO_MODEL),
    maxSeconds: MAX_VIDEO_SECONDS,
    oneChapterSeconds: ONE_CHAPTER_SECONDS,
    ...(await costRate(video)),
  };
  try {
    if (target.kind === "video") {
      const facts = await readVideo(run, target.id);
      return {
        kind: "video",
        id: facts.id,
        source: videoUrl(facts.id),
        playlist: target.playlistId ? playlistUrl(target.playlistId) : null,
        title: facts.title,
        channel: facts.channel,
        videos: [{ id: facts.id, title: facts.title, duration: facts.duration, cached: cached(facts.id) }],
        chapters: facts.chapters.map(({ title, start }) => ({ title, start })),
        ...model,
      };
    }
    const facts = await readPlaylist(run, target.id);
    return {
      kind: "playlist",
      id: facts.id,
      source: playlistUrl(facts.id),
      playlist: null,
      title: facts.title,
      channel: facts.channel,
      videos: facts.videos.map((entry) => ({ ...entry, cached: cached(entry.id) })),
      chapters: [],
      ...model,
    };
  } catch (error) {
    throw new TutorError(`yt-dlp cannot read ${url}: ${message(error)}. Often a later update of yt-dlp repairs the problem.`, 502);
  }
}

const VideoTocSchema = z.object({
  kind: z.enum(["video", "playlist"]),
  id: z.string(),
  title: z.string().min(1),
  channel: z.string(),
  videos: z.array(z.object({ id: z.string(), title: z.string(), duration: z.number().nullable() })).min(1),
});

export interface VideoFetchOptions {
  db: Db;
  dataDir: string;
  video: VideoAccess;
  subject: BookLocation["subject"];
  // The facts of the video or of the playlist, the selected videos of a playlist, and "again".
  body: { video?: unknown; chapters?: unknown; again?: unknown };
  stops: Set<number>;
}

// Start the transcripts of one video, or of some videos of a playlist. One video has no selection,
// because each request contains the full video.
export function startVideoFetch({ db, dataDir, video, subject, body, stops }: VideoFetchOptions): { view: FetchStartView; job: Promise<void> | null } {
  const config = video.config;
  if (!config) throw new TutorError(video.error ?? NO_VIDEO_MODEL, 503);
  const parsed = VideoTocSchema.safeParse(body.video);
  // The ids go into YouTube addresses, so they must be valid ids.
  const valid =
    parsed.success &&
    parseYoutubeUrl(parsed.data.kind === "video" ? videoUrl(parsed.data.id) : playlistUrl(parsed.data.id))?.kind === parsed.data.kind &&
    parsed.data.videos.every((entry) => parseYoutubeUrl(videoUrl(entry.id))?.kind === "video");
  if (!parsed.success || !valid) throw new TutorError("The facts of the video are not valid. Find the video again.");
  const facts = parsed.data;

  let selected = [1];
  if (facts.kind === "playlist") {
    const { chapters } = body;
    if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every((n) => Number.isInteger(n) && n > 0)) {
      throw new TutorError("Select at least one video.");
    }
    selected = [...new Set(chapters as number[])].sort((a, b) => a - b);
    const unknown = selected.filter((n) => n > facts.videos.length);
    if (unknown.length > 0) throw new TutorError(`The playlist has ${facts.videos.length} videos. There is no video ${unknown.join(", ")}.`);
  }
  const long = selected.filter((n) => tooLong(facts.videos[n - 1]!.duration));
  if (long.length > 0) throw new TutorError(`Video ${long.join(", ")} is too long. ${LIMIT}`);

  const entries = selected.map((n) => facts.videos[n - 1]!);
  const title =
    facts.kind === "video"
      ? facts.title
      : playlistBookTitle(facts.title, facts.videos.length, selected, entries.map((entry) => entry.title));
  const source = facts.kind === "video" ? videoUrl(facts.id) : playlistUrl(facts.id);
  const plan: DownloadPlan = {
    title,
    source,
    chapters: selected,
    total: entries.length,
    download: async (progress, stopped) => {
      // A playlist gives no chapters and sometimes no length, so the tutor reads each video before its transcript.
      const run = await video.ytDlp();
      const videos: VideoFacts[] = [];
      const skipped: { url: string; reason: string }[] = [];
      for (const [i, entry] of entries.entries()) {
        if (stopped()) throw new FetchStopped();
        progress({ text: `Reading the facts of video ${i + 1} of ${entries.length}.`, done: 0, total: entries.length });
        try {
          const facts = await readVideo(run, entry.id);
          if (tooLong(facts.duration)) skipped.push({ url: videoUrl(entry.id), reason: `the video is ${formatLength(facts.duration)} long. ${LIMIT}` });
          else videos.push(facts);
        } catch (error) {
          skipped.push({ url: videoUrl(entry.id), reason: `yt-dlp cannot read the video: ${message(error)}` });
        }
      }
      if (videos.length === 0) {
        throw new Error(`The tutor cannot transcribe the selected videos. ${skipped.map((item) => `${item.url}: ${item.reason}`).join(" ")}`);
      }
      const result = await fetchVideos({
        kind: facts.kind,
        title,
        channel: facts.channel,
        source,
        videos,
        client: video.client(config),
        model: describeVideoModel(config),
        cacheDir: transcriptsDir(dataDir),
        progress,
        stopped,
        ...(video.log ? { log: video.log } : {}),
      });
      return {
        epub: result.epub,
        result: {
          kind: "video",
          videos: result.videos,
          words: result.words,
          requests: result.requests,
          cost: result.cost,
          skipped: [...skipped, ...result.skipped],
        },
      };
    },
  };
  return startDownload({ db, dataDir, subject, plan, again: body.again, stops });
}

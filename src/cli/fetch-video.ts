import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeVideoModel, videoConfig } from "../config.js";
import { slugify } from "../ingest/core/text.js";
import { fetchVideos, ONE_CHAPTER_SECONDS, playlistBookTitle } from "../ingest/video/book.js";
import { createVideoClient, estimateCost, openRouterPrices } from "../ingest/video/client.js";
import { MAX_VIDEO_SECONDS } from "../ingest/video/transcript.js";
import { ensureYtDlp, readPlaylist, readVideo, ytDlpRunner } from "../ingest/video/ytdlp.js";
import { formatLength, formatTime, parseYoutubeUrl, playlistUrl, videoUrl, type VideoFacts } from "../ingest/video/youtube.js";
import { parseChapters } from "./chapters.js";

export interface VideoCommandArgs {
  url: string;
  // The videos of a playlist, for example "1-3,5".
  chapters?: string;
  title?: string;
  yes: boolean;
  ask: (question: string) => Promise<string>;
}

const BIN_DIR = join("data", "bin");
const TRANSCRIPTS_DIR = join("data", "web", "transcripts");
const tooLong = (seconds: number | null) => seconds !== null && seconds > MAX_VIDEO_SECONDS;
const LIMIT = `The tutor transcribes videos of up to ${MAX_VIDEO_SECONDS / 60} minutes, because a longer transcript does not fit into the answer of the model.`;

// Download the transcript of a YouTube video or playlist into an EPUB file in data/web/.
export async function fetchVideoCommand(args: VideoCommandArgs): Promise<void> {
  const target = parseYoutubeUrl(args.url);
  if (!target) throw new Error(`"${args.url}" is not the address of a YouTube video or playlist.`);
  const config = videoConfig();
  console.log(`\nVideo model: ${describeVideoModel(config)}`);
  const program = await ensureYtDlp({ dir: BIN_DIR, log: (line) => console.log(line) });
  const run = ytDlpRunner(program);

  let kind: "video" | "playlist";
  let title: string;
  let channel: string;
  let source: string;
  let videos: VideoFacts[];

  if (target.kind === "video") {
    if (args.chapters !== undefined) throw new Error("--chapters selects the videos of a playlist. For one video, the tutor transcribes the full video.");
    if (target.playlistId) console.log(`The address also names a playlist. For the full playlist, use ${playlistUrl(target.playlistId)}`);
    const video = await readVideo(run, target.id);
    console.log(`\nVideo: ${video.title}`);
    console.log(`Channel: ${video.channel}`);
    console.log(`Length: ${formatLength(video.duration)}`);
    if (video.chapters.length > 0) {
      console.log("\n  #   Start  Chapter");
      video.chapters.forEach((chapter, i) => console.log(`${String(i + 1).padStart(3)}  ${formatTime(chapter.start).padStart(6)}  ${chapter.title}`));
      if (video.duration <= ONE_CHAPTER_SECONDS) {
        console.log(`\nThe video is ${ONE_CHAPTER_SECONDS / 60} minutes or shorter, so the book gets one chapter. The YouTube chapters become its sections.`);
      }
    } else {
      console.log("The video has no YouTube chapters. The book gets one chapter, and the parser splits it by size.");
    }
    if (tooLong(video.duration)) throw new Error(`The video is ${formatLength(video.duration)} long. ${LIMIT}`);
    kind = "video";
    title = args.title ?? video.title;
    channel = video.channel;
    source = videoUrl(video.id);
    videos = [video];
  } else {
    const playlist = await readPlaylist(run, target.id);
    console.log(`\nPlaylist: ${playlist.title}`);
    console.log(`Channel: ${playlist.channel}`);
    console.log("\n  #  Length  Video");
    playlist.videos.forEach((video, i) => {
      const length = video.duration === null ? "?" : formatLength(video.duration);
      console.log(`${String(i + 1).padStart(3)}  ${length.padStart(6)}  ${video.title}${tooLong(video.duration) ? "  (too long)" : ""}`);
    });
    const allowed = playlist.videos.flatMap((video, i) => (tooLong(video.duration) ? [] : [i + 1]));
    if (allowed.length < playlist.videos.length) console.log(`\n${LIMIT}`);

    let answer = args.chapters;
    if (answer === undefined && !args.yes) answer = await args.ask("\nVideos to download, for example 1-3,5 [all]: ");
    const numbers = answer ? parseChapters(answer) : allowed;
    const unknown = numbers.filter((number) => number > playlist.videos.length);
    if (unknown.length > 0) throw new Error(`The playlist has ${playlist.videos.length} videos. There is no video ${unknown.join(", ")}.`);
    const long = numbers.filter((number) => !allowed.includes(number));
    if (long.length > 0) throw new Error(`Video ${long.join(", ")} is too long. ${LIMIT}`);
    if (numbers.length === 0) throw new Error("No video is selected.");

    console.log(`\nReading the facts of ${numbers.length} videos.`);
    videos = [];
    for (const number of numbers) {
      const video = await readVideo(run, playlist.videos[number - 1]!.id);
      if (tooLong(video.duration)) throw new Error(`Video ${number}, "${video.title}", is ${formatLength(video.duration)} long. ${LIMIT}`);
      videos.push(video);
    }
    kind = "playlist";
    title = args.title ?? playlistBookTitle(playlist.title, playlist.videos.length, numbers, videos.map((video) => video.title));
    channel = playlist.channel;
    source = playlistUrl(playlist.id);
  }

  const cached = videos.filter((video) => existsSync(join(TRANSCRIPTS_DIR, `${video.id}.json`)));
  const newVideos = videos.filter((video) => !cached.includes(video));
  const total = videos.reduce((sum, video) => sum + video.duration, 0);
  const newSeconds = newVideos.reduce((sum, video) => sum + video.duration, 0);
  console.log(`\nVideos: ${videos.length}, ${formatLength(total)} in total.${cached.length > 0 ? ` ${cached.length} of them are in the cache and cost nothing.` : ""}`);
  if (newVideos.length > 0) {
    if (config.provider === "openrouter") {
      const prices = await openRouterPrices(config.model);
      console.log(
        prices
          ? `Estimated cost: about $${estimateCost(newSeconds, prices).toFixed(2)} for ${newVideos.length === 1 ? "1 model request" : `${newVideos.length} model requests`}.`
          : `No cost estimate: the model list of OpenRouter does not have "${config.model}".`,
      );
    } else {
      console.log("No cost estimate for the Gemini API of Google. Its free tier allows 8 hours of YouTube video a day.");
    }
  }

  const file = join("data", "web", `${slugify(title)}.epub`);
  if (existsSync(file) && !args.yes) {
    if ((await args.ask(`The file ${file} exists. Replace it? [y/N] `)).toLowerCase() !== "y") {
      console.log("Stopped. To keep the two files, add --title with a different title.");
      return;
    }
  }
  if (newVideos.length > 0 && !args.yes) {
    if ((await args.ask("Get the transcripts now? [y/N] ")).toLowerCase() !== "y") {
      console.log("Stopped. Nothing was sent to the video model.");
      return;
    }
  }

  console.log("");
  const result = await fetchVideos({
    kind,
    title,
    channel,
    source,
    videos,
    client: createVideoClient(config),
    model: describeVideoModel(config),
    cacheDir: TRANSCRIPTS_DIR,
    log: (line) => console.log(line),
  });
  mkdirSync(join("data", "web"), { recursive: true });
  writeFileSync(file, result.epub);

  console.log(`\nBook: ${result.title}`);
  console.log(`Videos: ${result.videos}. Words: ${result.words.toLocaleString("en-US")}.`);
  const cost = result.cost !== null ? `, $${result.cost.toFixed(3)}` : "";
  console.log(`Model requests: ${result.requests}${cost}.`);
  if (result.skipped.length > 0) {
    console.log(`\nNo transcript: ${result.skipped.length}`);
    for (const item of result.skipped) console.log(`  ${item.url} (${item.reason})`);
  }
  console.log(`\nEPUB file: ${file}`);
  console.log(`Check it: npm run parse -- ${file}`);
  console.log("Add it to a subject: in the app, click \"Add a book\" and select the file.\n");
}

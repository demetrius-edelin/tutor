import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playlistFacts, playlistUrl, videoFacts, videoUrl, type PlaylistFacts, type VideoFacts } from "./youtube.js";

// yt-dlp reads the facts about YouTube videos: the title, the channel, the length, and the chapters.
// The tutor downloads no captions, no audio, and no video with it. The user does not install yt-dlp:
// the tutor downloads the single-file program into data/bin/ at the first use, and updates it each day.

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const UPDATE_AFTER_MS = 24 * 60 * 60 * 1000;

// Run yt-dlp with the arguments, and return its output.
export type YtDlpRunner = (args: string[]) => Promise<string>;

// The file of the yt-dlp release for a system, or null if yt-dlp has no single-file program for it.
export function ytDlpAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "win32") return ({ x64: "yt-dlp.exe", arm64: "yt-dlp_arm64.exe", ia32: "yt-dlp_x86.exe" } as Record<string, string>)[arch] ?? null;
  if (platform === "linux") return ({ x64: "yt-dlp_linux", arm64: "yt-dlp_linux_aarch64" } as Record<string, string>)[arch] ?? null;
  return null;
}

export interface YtDlpOptions {
  // The folder of the program, for example "data/bin".
  dir: string;
  log?: (line: string) => void;
  download?: (url: string) => Promise<Uint8Array>;
  run?: (program: string, args: string[]) => Promise<string>;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: Date;
}

async function httpDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`HTTP status ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Run a program and return its output. The error has the last ERROR line of the program, if it has one.
export function runProgram(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { maxBuffer: 256 * 1024 * 1024, timeout: 300_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const lines = `${stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
      const message = lines.filter((line) => line.startsWith("ERROR:")).at(-1) ?? lines.at(-1) ?? error.message;
      reject(new Error(message.replace(/^ERROR:\s*/, "")));
    });
  });
}

// The path of the yt-dlp program. At the first use, download it. If the last update is more than one day old, update it.
export async function ensureYtDlp(options: YtDlpOptions): Promise<string> {
  const log = options.log ?? (() => {});
  const platform = options.platform ?? process.platform;
  const asset = ytDlpAsset(platform, options.arch ?? process.arch);
  if (!asset) throw new Error(`The tutor cannot install yt-dlp on this system (${platform} ${options.arch ?? process.arch}).`);
  const program = join(options.dir, platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const stamp = join(options.dir, "yt-dlp.updated");
  const now = options.now ?? new Date();

  if (!existsSync(program)) {
    log(`Downloading yt-dlp (${asset}) from GitHub. This occurs one time.`);
    const download = options.download ?? httpDownload;
    const [data, sums] = await Promise.all([download(`${RELEASES}/${asset}`), download(`${RELEASES}/SHA2-256SUMS`)]);
    const expected = new TextDecoder()
      .decode(sums)
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === asset)?.[0];
    const actual = createHash("sha256").update(data).digest("hex");
    if (!expected || expected.toLowerCase() !== actual) throw new Error(`The checksum of the yt-dlp download (${asset}) is not correct.`);
    mkdirSync(options.dir, { recursive: true });
    writeFileSync(`${program}.part`, data);
    chmodSync(`${program}.part`, 0o755);
    renameSync(`${program}.part`, program);
    writeFileSync(stamp, now.toISOString());
    return program;
  }

  const checked = existsSync(stamp) ? statSync(stamp).mtime.getTime() : 0;
  if (now.getTime() - checked > UPDATE_AFTER_MS) {
    const run = options.run ?? runProgram;
    try {
      const output = await run(program, ["--update"]);
      const line = output.split("\n").map((item) => item.trim()).filter(Boolean).at(-1);
      if (line) log(`yt-dlp: ${line}`);
    } catch (error) {
      log(`yt-dlp could not update: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeFileSync(stamp, now.toISOString());
  }
  return program;
}

// The runner for the program. Each call ignores the configuration files of the user, prints no warnings,
// and uses Node.js for the JavaScript of YouTube, because Node.js runs the tutor already.
export function ytDlpRunner(program: string, run: (program: string, args: string[]) => Promise<string> = runProgram): YtDlpRunner {
  const base = ["--ignore-config", "--no-warnings", "--js-runtimes", `node:${process.execPath}`];
  return (args) => run(program, [...base, ...args]);
}

function readJson(output: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error(`yt-dlp gave no facts about the ${what}.`);
  }
}

export async function readVideo(run: YtDlpRunner, id: string): Promise<VideoFacts> {
  const facts = videoFacts(readJson(await run(["-J", "--no-playlist", "--skip-download", videoUrl(id)]), "video"));
  if (facts.duration <= 0) throw new Error(`yt-dlp gave no length for the video "${facts.title}". A live stream has no length.`);
  return facts;
}

export async function readPlaylist(run: YtDlpRunner, id: string): Promise<PlaylistFacts> {
  const facts = playlistFacts(readJson(await run(["-J", "--flat-playlist", playlistUrl(id)]), "playlist"));
  if (facts.videos.length === 0) throw new Error(`The playlist "${facts.title}" has no public videos.`);
  return facts;
}

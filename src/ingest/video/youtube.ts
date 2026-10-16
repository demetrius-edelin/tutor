// YouTube addresses, and the facts about videos and playlists that the tutor needs.

export type YoutubeTarget =
  | { kind: "video"; id: string; playlistId: string | null }
  | { kind: "playlist"; id: string };

export interface VideoChapter {
  title: string;
  // The start and the end in seconds.
  start: number;
  end: number;
}

export interface VideoFacts {
  id: string;
  title: string;
  channel: string;
  // The length in seconds.
  duration: number;
  // The YouTube chapters, in time order. Empty if the video has none.
  chapters: VideoChapter[];
  // The language of the speech, for example "en", or null.
  language: string | null;
}

export interface PlaylistEntry {
  id: string;
  title: string;
  // The length in seconds, or null if the playlist does not give it.
  duration: number | null;
}

export interface PlaylistFacts {
  id: string;
  title: string;
  channel: string;
  videos: PlaylistEntry[];
}

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{10,}$/;

// The video or the playlist of a YouTube address, or null for another address.
// An address with a video and a playlist, for example from a video in a playlist, gives the video.
export function parseYoutubeUrl(text: string): YoutubeTarget | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const list = url.searchParams.get("list");
  const playlistId = list && PLAYLIST_ID.test(list) ? list : null;
  const parts = url.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;
  if (url.hostname.toLowerCase() === "youtu.be") videoId = parts[0] ?? null;
  else if (parts[0] === "watch") videoId = url.searchParams.get("v");
  else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") videoId = parts[1] ?? null;
  if (videoId && VIDEO_ID.test(videoId)) return { kind: "video", id: videoId, playlistId };
  if (parts[0] === "playlist" && playlistId) return { kind: "playlist", id: playlistId };
  return null;
}

export function isYoutubeUrl(text: string): boolean {
  return parseYoutubeUrl(text) !== null;
}

export function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function playlistUrl(id: string): string {
  return `https://www.youtube.com/playlist?list=${id}`;
}

// The address of a point in a video.
export function timeUrl(id: string, seconds: number): string {
  return `${videoUrl(id)}&t=${Math.floor(seconds)}s`;
}

// 754 gives "12:34", and 3845 gives "1:04:05".
export function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// A length for people, for example "12 min" or "1 h 05 min".
export function formatLength(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

type Json = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// The facts of a video from the JSON of yt-dlp.
export function videoFacts(json: Json): VideoFacts {
  const id = text(json.id);
  const duration = number(json.duration) ?? 0;
  const chapters = (Array.isArray(json.chapters) ? (json.chapters as Json[]) : [])
    .map((chapter, i) => ({
      title: text(chapter.title) || `Part ${i + 1}`,
      start: number(chapter.start_time) ?? 0,
      end: number(chapter.end_time) ?? duration,
    }))
    .filter((chapter) => chapter.end > chapter.start)
    .sort((a, b) => a.start - b.start);
  return {
    id,
    title: text(json.title) || id,
    channel: text(json.channel) || text(json.uploader) || "YouTube",
    duration,
    chapters,
    language: text(json.language) || null,
  };
}

// The facts of a playlist from the JSON of yt-dlp with --flat-playlist.
export function playlistFacts(json: Json): PlaylistFacts {
  const id = text(json.id);
  const videos = (Array.isArray(json.entries) ? (json.entries as Json[]) : [])
    .map((entry) => ({ id: text(entry.id), title: text(entry.title), duration: number(entry.duration) }))
    // A private or deleted video has no length, and it has no title or a title in brackets, for example "[Private video]".
    .filter((entry) => VIDEO_ID.test(entry.id) && entry.title !== "" && !/^\[(private|deleted) video\]$/i.test(entry.title));
  return {
    id,
    title: text(json.title) || id,
    channel: text(json.channel) || text(json.uploader) || "YouTube",
    videos,
  };
}

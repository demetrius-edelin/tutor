import type { VideoMoment } from "../server/api-types.js";

// Times and addresses of YouTube videos, with the same formats as the command: 754 gives "12:34".
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

// The embedded player. The player of youtube-nocookie.com sets no cookies before the user plays the video.
export function embedUrl(moment: VideoMoment, autoplay: boolean): string {
  return `https://www.youtube-nocookie.com/embed/${moment.id}?start=${moment.start}&rel=0${autoplay ? "&autoplay=1" : ""}`;
}

export function watchUrl(moment: VideoMoment): string {
  return `https://www.youtube.com/watch?v=${moment.id}&t=${moment.start}s`;
}

// The point of a time link in a transcript, for example "https://www.youtube.com/watch?v=<id>&t=245s", or null for another link.
export function timeLink(href: string): VideoMoment | null {
  const match = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})&t=(\d+)s$/.exec(href);
  return match ? { id: match[1]!, start: Number(match[2]) } : null;
}

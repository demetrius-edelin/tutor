import type { Clip } from "./client.js";
import { checkTranscript, FENCE, parseTranscript, secondsOf, TIME } from "./transcript.js";
import { formatTime } from "./youtube.js";

// The transcript of a long video, in clips. Only the Gemini API of Google takes a clip of a YouTube video. The clips
// have equal lengths. Each clip also contains the first minute of the next clip. A clip stops in a sentence, and the
// next clip starts in a sentence. The join of two clips removes both broken edges in the overlap.
// The transcript of a clip has the times of the full video.

// The longest clip, with no overlap. The model writes about 340 to 420 output tokens for each minute of video, so a
// clip of 45 minutes needs much fewer tokens than the output limit.
export const CLIP_SECONDS = 45 * 60;
export const OVERLAP_SECONDS = 60;
// The words in the same sequence that both transcripts must have in the overlap.
export const JOIN_WORDS = 8;
// The longest paragraph of a transcript. A paragraph that starts this long before the overlap can reach into it.
const PARAGRAPH_SECONDS = 60;
// The model can write a time some seconds before the start of a clip.
const CLIP_TOLERANCE = 15;

// The clips of a video, of equal length and of at most `clipSeconds`. Each clip, except the last, also contains the
// first `overlap` seconds of the next clip. A video that is not longer than `clipSeconds` has one clip.
export function planClips(duration: number, clipSeconds = CLIP_SECONDS, overlap = OVERLAP_SECONDS): Clip[] {
  const count = Math.max(1, Math.ceil(duration / clipSeconds));
  const length = duration / count;
  return Array.from({ length: count }, (_, i) => ({
    start: Math.round(i * length),
    end: i === count - 1 ? duration : Math.round((i + 1) * length) + overlap,
  }));
}

// The reason why the transcript of a clip is not complete, or null. The checks of a full transcript apply, with the
// times moved to the start of the clip. Text before the first time, for example an introduction, is not a problem:
// the join removes it in each clip after the first.
export function clipProblem(text: string, clip: Clip, finishReason: string): string | null {
  const firstTime = text
    .split("\n")
    .map((line) => TIME.exec(line))
    .find((match) => match !== null);
  const first = firstTime ? secondsOf(firstTime) : 0;
  if (clip.start > 0 && first < clip.start - CLIP_TOLERANCE) {
    return `the first time is ${formatTime(first)}, before the start of the clip at ${formatTime(clip.start)}`;
  }
  const paragraphs = parseTranscript(firstTime ? text.slice(text.indexOf(firstTime[0])) : text);
  const moved = paragraphs.map((paragraph) => ({ ...paragraph, start: Math.max(0, paragraph.start - clip.start) }));
  return checkTranscript(moved, clip.end - clip.start, finishReason);
}

// A word of the prose of a transcript, in lowercase, with the start time of its paragraph and its place in the text.
// `to` is after the punctuation that follows the word, for example after "ends." or "ends,".
export interface PlacedWord {
  word: string;
  at: number;
  from: number;
  to: number;
  // True if a sentence ends after the word.
  sentenceEnd: boolean;
}

interface ProseLine {
  line: string;
  // The place of the line in the text.
  from: number;
  // The time at the start of the line, or null.
  time: RegExpExecArray | null;
}

// The lines of a transcript outside the code blocks.
function proseLines(text: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const from = offset;
    offset += line.length + 1;
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opened = FENCE.exec(line);
    if (opened) {
      fence = opened[1]!;
      continue;
    }
    lines.push({ line, from, time: TIME.exec(line) });
  }
  return lines;
}

const WORD = /[\p{L}\p{N}']+/gu;
const PUNCTUATION = /[^\s\p{L}\p{N}]/u;

// The words of the prose of a transcript, with no code blocks, no tables, and no times.
export function placedWords(text: string): PlacedWord[] {
  const words: PlacedWord[] = [];
  let at = 0;
  for (const { line, from, time } of proseLines(text)) {
    if (time) at = secondsOf(time);
    if (/^\s*\|/.test(line)) continue;
    const skip = time ? time[0].length : 0;
    for (const match of line.slice(skip).matchAll(WORD)) {
      const start = from + skip + match.index;
      let to = start + match[0].length;
      while (to < from + line.length && PUNCTUATION.test(text[to]!)) to++;
      words.push({ word: match[0].toLowerCase(), at, from: start, to, sentenceEnd: /[.!?]/.test(text.slice(start + match[0].length, to)) });
    }
  }
  return words;
}

export interface Join {
  // "text": the two transcripts have the same words in the overlap. "time": no words agree, so the join is at the
  // first paragraph after the middle of the overlap. Then some seconds can repeat or go missing.
  method: "text" | "time";
  // The time of the paragraph of the join.
  at: number;
  // The words that both transcripts have before the join. Empty for "time".
  words: string;
  // The end of the first text, and the start of the second text.
  firstEnd: number;
  secondStart: number;
}

// Join the transcript of a clip to the transcript before it. The overlap is the start of the second clip to the end of
// the first clip. The first text can already contain the earlier clips.
export function joinTranscripts(first: string, second: string, overlap: Clip): { text: string; join: Join } {
  const a = first.replace(/\r\n/g, "\n");
  const b = second.replace(/\r\n/g, "\n");
  const join = textJoin(a, b, overlap) ?? timeJoin(a, b, overlap);
  const text =
    join.method === "text"
      ? a.slice(0, join.firstEnd) + b.slice(join.secondStart)
      : `${a.slice(0, join.firstEnd).trimEnd()}\n\n${b.slice(join.secondStart).trimStart()}`;
  return { text, join };
}

// The join at a sentence that both transcripts contain: at least JOIN_WORDS words in the same sequence, near the
// middle of the overlap. The join is after the first sentence end in these words, or after their last word. The code
// blocks and the tables have no words here, so a join is never in a code block or a table.
function textJoin(first: string, second: string, overlap: Clip): Join | null {
  const a = placedWords(first).filter((word) => word.at >= overlap.start - PARAGRAPH_SECONDS);
  const b = placedWords(second).filter((word) => word.at <= overlap.end);
  const key = (words: PlacedWord[], i: number) =>
    words
      .slice(i, i + JOIN_WORDS)
      .map((word) => word.word)
      .join(" ");
  const starts = new Map<string, number[]>();
  for (let j = 0; j + JOIN_WORDS <= b.length; j++) starts.set(key(b, j), [...(starts.get(key(b, j)) ?? []), j]);

  const middle = (overlap.start + overlap.end) / 2;
  let best: { i: number; j: number; length: number } | null = null;
  for (let i = 0; i + JOIN_WORDS <= a.length; i++) {
    for (const j of starts.get(key(a, i)) ?? []) {
      // The same words far away in the other transcript are a repeated phrase, not the same moment.
      if (Math.abs(a[i]!.at - b[j]!.at) > 2 * PARAGRAPH_SECONDS) continue;
      let length = JOIN_WORDS;
      while (i + length < a.length && j + length < b.length && a[i + length]!.word === b[j + length]!.word) length++;
      if (!best || Math.abs(a[i]!.at - middle) < Math.abs(a[best.i]!.at - middle)) best = { i, j, length };
    }
  }
  if (!best) return null;

  const { i, j, length } = best;
  const offsets = Array.from({ length }, (_, k) => k);
  const k = offsets.find((n) => a[i + n]!.sentenceEnd && b[j + n]!.sentenceEnd) ?? offsets.find((n) => a[i + n]!.sentenceEnd) ?? length - 1;
  return {
    method: "text",
    at: a[i + k]!.at,
    words: a
      .slice(i, i + k + 1)
      .map((word) => word.word)
      .join(" "),
    firstEnd: a[i + k]!.to,
    secondStart: b[j + k]!.to,
  };
}

function timeJoin(first: string, second: string, overlap: Clip): Join {
  const middle = Math.round((overlap.start + overlap.end) / 2);
  return {
    method: "time",
    at: middle,
    words: "",
    firstEnd: paragraphFrom(first, middle) ?? first.length,
    secondStart: paragraphFrom(second, middle) ?? second.length,
  };
}

// The place of the first paragraph that starts at `seconds` or later, or null.
function paragraphFrom(text: string, seconds: number): number | null {
  return proseLines(text).find(({ time }) => time && secondsOf(time) >= seconds)?.from ?? null;
}

// Run the items with at most `limit` at the same time. The results are in the order of the items.
export async function inParallel<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

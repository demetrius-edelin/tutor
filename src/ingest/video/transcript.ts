import { formatTime, timeUrl } from "./youtube.js";

// The transcript of a video: the prompt, the paragraphs with their start times, and the checks.

export interface TranscriptParagraph {
  // The start time in seconds.
  start: number;
  // The text of the paragraph without its time, with the code blocks and tables from the screen.
  markdown: string;
}

// The model can write a time a few seconds too early. A smaller step back is not an error.
const BACK_TOLERANCE = 5;
// The longest time with no paragraph.
const MAX_GAP = 180;
// The model writes about 550 output tokens for each minute of video, more for code on the screen.
const TOKENS_PER_MINUTE = 700;
export const MAX_OUTPUT_TOKENS = 65_536;
// A longer video does not fit into the output limit of the model.
export const MAX_VIDEO_SECONDS = 90 * 60;

export const CODE_NOTE = "_The tutor read this code from the video:_";
export const TABLE_NOTE = "_The tutor read this table from the video:_";

export function maxTokensFor(seconds: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, 1000 + Math.ceil(seconds / 60) * TOKENS_PER_MINUTE);
}

export function transcriptPrompt(seconds: number): string {
  return `Write a transcript of this video, for a student who learns from it later. The video is ${formatTime(seconds)} long. The transcript must cover the full video.

Rules:
- Write the exact words of the speaker. Do not summarize, shorten, or add words. Remove only filler sounds such as "um" and "uh".
- Start a new paragraph at each change of idea, or after 30 to 60 seconds. Begin each paragraph with its start time in square brackets, for example [4:05] or [1:04:05].
- When the screen shows code, a terminal command, a table, or a slide with text, write its content at the point where it appears. Use a fenced code block with the language for code, and a Markdown table for a table. Copy the code exactly. If the code on the screen changes, write the new version.
- When the speaker defines a term, write the term in bold one time, at the definition.
- Do not write headings.
- Write only the transcript. No introduction and no notes at the end.`;
}

const TIME = /^\[(?:(\d+):)?(\d+):(\d{2})\]\s*/;
const FENCE = /^\s*(```|~~~)/;

// Split the answer of the model into paragraphs at the lines that start with a time, for example "[4:05]".
// A heading line goes. Text before the first time belongs to a paragraph at 0:00.
export function parseTranscript(text: string): TranscriptParagraph[] {
  const paragraphs: { start: number; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const current = paragraphs.at(-1);
    if (fence) {
      current?.lines.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const time = TIME.exec(line);
    if (time) {
      const start = Number(time[1] ?? 0) * 3600 + Number(time[2]) * 60 + Number(time[3]);
      paragraphs.push({ start, lines: [line.slice(time[0].length)] });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    const opened = FENCE.exec(line);
    if (opened) fence = opened[1]!;
    if (current) current.lines.push(line);
    else if (line.trim()) paragraphs.push({ start: 0, lines: [line] });
  }
  return paragraphs
    .map((paragraph) => ({ start: paragraph.start, markdown: paragraph.lines.join("\n").trim() }))
    .filter((paragraph) => paragraph.markdown !== "");
}

// The reason why a transcript is not complete, or null for a good transcript.
// The checks find a short transcript. They do not find wrong words or wrong code.
export function checkTranscript(paragraphs: TranscriptParagraph[], seconds: number, finishReason: string): string | null {
  if (finishReason === "length") return "the transcript reached the token limit";
  if (finishReason !== "stop") return `the model stopped with the finish reason "${finishReason}"`;
  if (paragraphs.length === 0) return "the transcript has no paragraphs with a start time";
  let previous = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.start < previous - BACK_TOLERANCE) return `the time ${formatTime(paragraph.start)} comes after ${formatTime(previous)}`;
    if (paragraph.start > seconds + BACK_TOLERANCE) return `the time ${formatTime(paragraph.start)} is after the end of the video`;
    if (paragraph.start - previous > MAX_GAP) return `the transcript has no text from ${formatTime(previous)} to ${formatTime(paragraph.start)}`;
    previous = Math.max(previous, paragraph.start);
  }
  if (seconds - previous > Math.max(120, seconds * 0.1)) {
    return `the transcript stops at ${formatTime(previous)}, but the video is ${formatTime(seconds)} long`;
  }
  return null;
}

const TABLE_ROW = /^\s*\|/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// All code blocks and tables of a transcript come from the screen. Put a note before each one,
// because the model can make an error, as for the code of an image.
export function addNotes(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    if (fence) {
      out.push(line);
      if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    const opened = FENCE.exec(line);
    if (opened) {
      fence = opened[1]!;
      out.push("", CODE_NOTE, "", line);
      return;
    }
    const tableStart = TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? "") && !TABLE_ROW.test(lines[i - 1] ?? "");
    if (tableStart) out.push("", TABLE_NOTE, "");
    out.push(line);
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The Markdown of a paragraph for the book: a link to its time in the video, the text, and the notes.
export function paragraphMarkdown(videoId: string, paragraph: TranscriptParagraph): string {
  return `[${formatTime(paragraph.start)}](${timeUrl(videoId, paragraph.start)}) ${addNotes(paragraph.markdown)}`;
}

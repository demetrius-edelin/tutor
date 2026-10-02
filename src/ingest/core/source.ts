import { posix } from "node:path";
import type { Block } from "./blocks.js";

// A place in the book: a file, and an element id in it.
// For a PDF, each page is one file, for example "page-12".
export interface Target {
  file: string;
  anchor: string | null;
}

export interface TocEntry extends Target {
  title: string;
  children: TocEntry[];
}

export interface PageTarget extends Target {
  label: string;
}

export interface Landmark extends Target {
  type: string;
}

// The result of a format reader (EPUB or PDF). The core turns it into chapters and sections.
export interface BookSource {
  format: "epub" | "pdf";
  title: string;
  authors: string[];
  tocSource: "nav" | "ncx" | "outline" | "none";
  toc: TocEntry[];
  landmarks: Landmark[];
  // All blocks of the book in reading order. The index of a block is its position in this list.
  blocks: Block[];
  // Problems that the reader found, for the parse report.
  notes: string[];
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function resolveHref(baseFile: string, href: string): Target {
  const hash = href.indexOf("#");
  const path = hash >= 0 ? href.slice(0, hash) : href;
  const anchor = hash >= 0 ? href.slice(hash + 1) : "";
  const file = path === "" ? baseFile : posix.normalize(posix.join(posix.dirname(baseFile), safeDecode(path)));
  return { file, anchor: anchor ? safeDecode(anchor) : null };
}

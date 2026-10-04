import { extname } from "node:path";
import { buildBook, type ParseOptions } from "./core/book.js";
import type { BookSource } from "./core/source.js";
import type { ParsedBook } from "./core/types.js";
import { readEpub } from "./epub/read.js";
import { readPdf } from "./pdf/read.js";

export type { ParseOptions } from "./core/book.js";

// Read an EPUB or PDF book into blocks, a table of contents, and images. The file name gives the format,
// and the title of a PDF without a title. buildBook then makes the chapters and sections.
export async function readBookSource(data: Uint8Array, fileName: string): Promise<BookSource> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".epub") return readEpub(data);
  if (extension === ".pdf") return readPdf(data, fileName);
  throw new Error(`The file "${fileName}" is not an EPUB or a PDF file.`);
}

// Parse an EPUB or PDF book.
export async function parseBook(data: Uint8Array, fileName: string, options: ParseOptions = {}): Promise<ParsedBook> {
  return buildBook(await readBookSource(data, fileName), options);
}

export async function parseEpub(data: Uint8Array, options: ParseOptions = {}): Promise<ParsedBook> {
  return buildBook(await readEpub(data), options);
}

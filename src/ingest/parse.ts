import { extname } from "node:path";
import { buildBook, type ParseOptions } from "./core/book.js";
import type { ParsedBook } from "./core/types.js";
import { readEpub } from "./epub/read.js";
import { readPdf } from "./pdf/read.js";

export type { ParseOptions } from "./core/book.js";

// Parse an EPUB or PDF book. The file name gives the format, and the title of a PDF without a title.
export async function parseBook(data: Uint8Array, fileName: string, options: ParseOptions = {}): Promise<ParsedBook> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".epub") return buildBook(await readEpub(data), options);
  if (extension === ".pdf") return buildBook(await readPdf(data, fileName), options);
  throw new Error(`The file "${fileName}" is not an EPUB or a PDF file.`);
}

export async function parseEpub(data: Uint8Array, options: ParseOptions = {}): Promise<ParsedBook> {
  return buildBook(await readEpub(data), options);
}

import { isTag, isText, type Element } from "domhandler";
import type { Block } from "./blocks.js";
import { descendants, loadFragment, localName, semanticTypes, type Doc } from "./dom.js";
import { resolveHref, type Target } from "./source.js";
import { normalizeSpace } from "./text.js";

const LABEL =
  /^(notes?|tips?|warnings?|important|caution|examples?|figure|table|listing|hint|step\s*\d+|(short |long )?answer|solution|output|results?|syntax|explanation|definition|summary)$/i;

// Authors also use emphasis for stress, for example "only" or "all". These words are not terms.
const COMMON_WORDS = new Set(
  (
    "a an the and or but nor not no yes so if then than that this these those it its is are was were be been " +
    "do does did can cannot could will would should must may might shall to of in on at by for from with as " +
    "all any some each every both either neither none only also just even very really much many more most less " +
    "least first last next new old same other another own one two always never often sometimes usually here " +
    "there now when where why how what which who whom whose you your we our they their he she his her i me my " +
    "before after above below again still already else ever too quite rather enough exactly actually"
  ).split(" "),
);

function cleanTerm(text: string, maxWords: number, maxLength = 60): string | null {
  const term = normalizeSpace(text).replace(/^[\s"“'‘([]+|[\s"”'’)\].,;:\-–—]+$/g, "");
  if (!term || term.length > maxLength) return null;
  if (term.split(" ").length > maxWords) return null;
  if (!/\p{L}/u.test(term)) return null;
  if (/[.!?]\s/.test(term)) return null;
  // A fragment of code, for example "salary >", is not a term.
  if (/[=<>]/.test(term)) return null;
  if (LABEL.test(term)) return null;
  if (!term.includes(" ") && COMMON_WORDS.has(term.toLowerCase())) return null;
  return term;
}

export interface MarkedTerm {
  term: string;
  source: "dfn" | "bold" | "emphasis";
}

// The terms that the author marks in the text: <dfn> elements, bold text, and emphasis.
export function markedTerms(html: string): MarkedTerm[] {
  const $ = loadFragment(html);
  const terms: MarkedTerm[] = [];
  for (const element of descendants($)) {
    const name = localName(element);
    let source: MarkedTerm["source"];
    if (name === "dfn" || semanticTypes(element).includes("glossterm")) source = "dfn";
    else if (name === "strong" || name === "b") source = "bold";
    else if (name === "em" || name === "i") source = "emphasis";
    else continue;
    if ($(element).closest("pre, code, h1, h2, h3, h4, h5, h6, figcaption").length > 0) continue;
    const text = normalizeSpace($(element).text());
    // Bold or emphasis on a full paragraph marks a heading, not a term.
    if (source !== "dfn" && text === normalizeSpace($(element).parent().text())) continue;
    const term = cleanTerm(text, source === "emphasis" ? 4 : source === "bold" ? 6 : 8);
    if (term) terms.push({ term, source });
  }
  return terms;
}

// The items of a summary section: its list items, or its paragraphs if it has no list.
export function summaryItems(htmls: string[]): string[] {
  const items: string[] = [];
  for (const html of htmls) {
    const $ = loadFragment(html);
    const listItems = descendants($).filter((element) => localName(element) === "li");
    const sources = listItems.length > 0 ? listItems : descendants($).filter((element) => localName(element) === "p");
    for (const element of sources) {
      const text = normalizeSpace($(element).text());
      if (text.split(" ").length < 3) continue;
      items.push(text.length > 300 ? `${text.slice(0, 297)}...` : text);
    }
  }
  return items.slice(0, 20);
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export function glossaryEntries(htmls: string[]): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const html of htmls) {
    const $ = loadFragment(html);
    for (const dt of descendants($).filter((element) => localName(element) === "dt")) {
      const term = cleanTerm($(dt).text(), 8, 80);
      if (!term) continue;
      const parts: string[] = [];
      let next = $(dt).next();
      while (next.length > 0 && localName(next.get(0)!) === "dd") {
        parts.push(normalizeSpace(next.text()));
        next = next.next();
      }
      entries.push({ term, definition: parts.join(" ") });
    }
    // A paragraph that starts with a bold term is also a glossary entry.
    for (const paragraph of descendants($).filter((element) => localName(element) === "p")) {
      const first = paragraph.children.find((node) => !(isText(node) && node.data.trim() === ""));
      if (!first || !isTag(first) || !["strong", "b", "dfn"].includes(localName(first))) continue;
      const termText = normalizeSpace($(first).text());
      const term = cleanTerm(termText, 8, 80);
      if (!term) continue;
      const definition = normalizeSpace($(paragraph).text()).slice(termText.length);
      entries.push({ term, definition: definition.replace(/^[\s:—–-]+/, "") });
    }
  }
  return dedupe(entries, (entry) => entry.term);
}

export interface IndexEntry {
  term: string;
  targets: Target[];
}

function stripPageRefs(text: string): string {
  let result = text;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/[,;]?\s*\d+([–-]\d+)?\s*$/, "").replace(/[,;:\s]+$/, "");
  } while (result !== previous);
  return result;
}

function ownTerm($: Doc, item: Element): { term: string | null; links: Element[] } {
  const own = $(item).clone();
  own.find("ul, ol").remove();
  const links = own.find("a[href]").toArray();
  return { term: cleanTerm(stripPageRefs(normalizeSpace(own.text())), 10, 80), links };
}

export function indexEntries(blocks: Block[]): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const block of blocks) {
    if (block.kind !== "content") continue;
    const $ = loadFragment(block.html);
    const items = descendants($).filter(
      (element) => localName(element) === "li" || (localName(element) === "p" && $(element).closest("li").length === 0),
    );
    for (const item of items) {
      const { term, links } = ownTerm($, item);
      if (!term) continue;
      const parent = $(item).parents("li").get(0);
      const parentTerm = parent ? ownTerm($, parent).term : null;
      entries.push({
        term: parentTerm ? `${term} (${parentTerm})` : term,
        targets: links.map((link) => resolveHref(block.file, link.attribs.href!)),
      });
    }
  }
  return entries;
}

export function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item).toLowerCase();
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

// True if the text contains the term as a full word or phrase. Both values must be in lower case.
export function containsTerm(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(term, from);
    if (index < 0) return false;
    const before = text[index - 1] ?? " ";
    const after = text[index + term.length] ?? " ";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = index + 1;
  }
}

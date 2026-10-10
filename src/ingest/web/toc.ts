import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { z } from "zod";
import type { LlmClient } from "../../llm/index.js";
import { blockText, descendants, localName } from "../core/dom.js";
import { normalizeSpace } from "../core/text.js";
import { bodyText, RobotsError, type Downloader } from "./http.js";

export interface WebPage {
  title: string;
  url: string;
}

export interface WebChapter {
  title: string;
  pages: WebPage[];
}

export interface WebToc {
  title: string;
  language: string;
  startUrl: string;
  // Where the table of contents comes from: an llms.txt file, or the links of an HTML page.
  source: "llms.txt" | "html";
  tocUrl: string;
  // The pages of the book are in this folder, for example "https://docs.cakemail.com/en/docs/".
  scope: string;
  chapters: WebChapter[];
}

export class TocError extends Error {
  override name = "TocError";
}

function withoutHash(url: string): string {
  const hash = url.indexOf("#");
  return hash >= 0 ? url.slice(0, hash) : url;
}

// An absolute http or https address without the hash, or null.
export function absoluteUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// The scope is the folder of the start address. If no page is in that folder, the scope is the parent folder.
// For example, "https://site.com/en/docs/first-steps" gives "https://site.com/en/docs/".
export function scopeOf(startUrl: string, pageUrls: string[]): string {
  const start = new URL(startUrl);
  const path = start.pathname;
  if (path.endsWith("/")) return `${start.origin}${path}`;
  const own = `${start.origin}${path}/`;
  if (pageUrls.some((url) => url.startsWith(own))) return own;
  return `${start.origin}${path.slice(0, path.lastIndexOf("/") + 1)}`;
}

// A page is in the scope if it is in the folder, or if it is the folder address without the last "/".
export function inScope(url: string, scope: string): boolean {
  const address = withoutHash(url).split("?")[0]!;
  return address.startsWith(scope) || `${address}/` === scope;
}

// The places to look for llms.txt: each folder of the start address, from the deepest folder to the root.
export function llmsTxtUrls(startUrl: string): string[] {
  const start = new URL(startUrl);
  let path = start.pathname;
  const folders: string[] = [];
  if (!path.endsWith("/")) {
    if (!/\.[a-z0-9]+$/i.test(path)) folders.push(`${path}/`);
    path = path.slice(0, path.lastIndexOf("/") + 1);
  }
  for (;;) {
    folders.push(path);
    if (path === "/") break;
    path = path.slice(0, path.slice(0, -1).lastIndexOf("/") + 1);
  }
  return folders.map((folder) => `${start.origin}${folder}llms.txt`);
}

export interface LlmsTxt {
  title: string;
  // The "##" headings of the file and their links. The links before the first "##" heading have no title.
  groups: { title: string | null; links: WebPage[] }[];
}

const LIST_LINK = /^\s*[-*+]\s*\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/;

export function parseLlmsTxt(text: string, fileUrl: string): LlmsTxt {
  const result: LlmsTxt = { title: "", groups: [] };
  let group: LlmsTxt["groups"][number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,2})\s+(.+?)\s*#*$/.exec(line);
    if (heading?.[1] === "#") {
      if (!result.title) result.title = heading[2]!;
      continue;
    }
    if (heading) {
      group = { title: heading[2]!, links: [] };
      result.groups.push(group);
      continue;
    }
    const link = LIST_LINK.exec(line);
    const url = link ? absoluteUrl(link[2]!, fileUrl) : null;
    if (!link || !url) continue;
    if (!group) {
      group = { title: null, links: [] };
      result.groups.push(group);
    }
    group.links.push({ title: normalizeSpace(link[1]!), url });
  }
  return result;
}

// "campaign-creation" gives "Campaign creation".
function folderTitle(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // Keep the segment as it is.
  }
  text = normalizeSpace(text.replace(/[-_]+/g, " "));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The chapters from an llms.txt file. If the pages in the scope are under more than one "##" heading,
// each heading starts a chapter. If not, each folder in the scope is a chapter, and a page outside a folder is a chapter of its own.
export function llmsChapters(file: LlmsTxt, scope: string): WebChapter[] {
  const seen = new Set<string>();
  const groups = file.groups
    .map((group) => ({
      title: group.title,
      links: group.links.filter((link) => {
        if (!inScope(link.url, scope) || seen.has(link.url)) return false;
        seen.add(link.url);
        return true;
      }),
    }))
    .filter((group) => group.links.length > 0);
  if (groups.length > 1) return groups.map((group) => ({ title: group.title ?? file.title, pages: group.links }));

  const chapters = new Map<string, WebChapter>();
  for (const link of groups[0]?.links ?? []) {
    const rest = link.url.startsWith(scope) ? link.url.slice(scope.length) : "";
    const slash = rest.indexOf("/");
    const key = slash > 0 ? `folder:${rest.slice(0, slash)}` : `page:${link.url}`;
    const chapter = chapters.get(key) ?? { title: slash > 0 ? folderTitle(rest.slice(0, slash)) : link.title, pages: [] };
    chapter.pages.push(link);
    chapters.set(key, chapter);
  }
  return [...chapters.values()];
}

// One line of the list for the model: a link, or the title of a group with no link.
export interface LinkItem {
  text: string;
  url: string | null;
  depth: number;
}

export interface PageLinks {
  title: string;
  language: string | null;
  items: LinkItem[];
  // The addresses of the <iframe> elements from the same site.
  frames: string[];
}

const LIST = new Set(["ul", "ol"]);
const MAX_LABEL_LENGTH = 100;

// The links of a page in page order, with their depth in lists. A list item with no link of its own gives a group title.
export function collectLinks(html: string, pageUrl: string): PageLinks {
  // Without scripts, the parser reads the content of <noscript>. Some sites put the table of contents there.
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const origin = new URL(pageUrl).origin;
  const listDepth = (element: Element) => $(element).parents().toArray().filter((parent) => LIST.has(localName(parent))).length;
  const items: LinkItem[] = [];
  const frames: string[] = [];
  const body = descendants($).find((element) => localName(element) === "body");

  for (const element of body ? descendants($, body) : []) {
    const name = localName(element);
    if (name === "iframe" && element.attribs.src) {
      const url = absoluteUrl(element.attribs.src, pageUrl);
      if (url && new URL(url).origin === origin && !frames.includes(url)) frames.push(url);
    } else if (name === "a" && element.attribs.href) {
      const url = absoluteUrl(element.attribs.href, pageUrl);
      // A card link can contain a heading, a number, and a series name. The heading is the title.
      const heading = descendants($, element).find((child) => /^h[1-6]$/.test(localName(child)));
      const text =
        normalizeSpace(blockText(heading ?? element)) || normalizeSpace(element.attribs["aria-label"] ?? element.attribs.title ?? "");
      if (!url || !text) continue;
      const previous = items.at(-1);
      if (previous?.url === url && previous.text === text) continue;
      items.push({ text, url, depth: listDepth(element) });
    } else if (name === "li") {
      // The text of the item outside its nested lists. The item is a group title if that part has no link.
      // Some sites put the nested list in a <nav> or a <details> element, so a child with a list is a part of the nested list.
      const own = element.children.filter(
        (child) => !(child.type === "tag" && (LIST.has(localName(child as Element)) || $(child).find("ul, ol").length > 0)),
      );
      const ownLink = own.some((child) => child.type === "tag" && (localName(child as Element) === "a" || $(child).find("a").length > 0));
      const text = normalizeSpace(own.map(blockText).join(" "));
      if (!ownLink && text && text.length <= MAX_LABEL_LENGTH) items.push({ text, url: null, depth: listDepth(element) });
    }
  }
  return {
    title: normalizeSpace($("title").first().text()),
    language: $("html").attr("lang")?.trim() || null,
    items,
    frames,
  };
}

// Keep the links in the scope. Keep a group title only if a link in the scope comes under it.
export function scopedItems(items: LinkItem[], scope: string): LinkItem[] {
  const links = items.filter((item) => item.url === null || inScope(item.url, scope));
  return links.filter((item, i) => {
    if (item.url !== null) return true;
    for (const next of links.slice(i + 1)) {
      if (next.depth <= item.depth && next.url === null) return false;
      if (next.url !== null) return next.depth >= item.depth;
    }
    return false;
  });
}

const TOC_SYSTEM = `You find the table of contents of an online book or of an online documentation site. You get a numbered list of the links and the group titles on one page of the site, in page order. The indent shows the depth of each item in the lists of the page. A group title has no link.

Rules:
- Keep the links to the pages of the book or of the documentation. Remove the links of menus, headers, footers, language and version selectors, login, search, and social sites.
- Remove the links to a print version or to a version of the whole book on one page.
- Put each page in the answer one time only. Some sites show the same text under two titles and two addresses. The addresses then often have the same number or the same words. Keep one of them.
- Group the pages into chapters, in reading order. A top-level item with children is a chapter, and its children are the pages of the chapter. A top-level link with no children is a chapter with one page.
- A chapter can start with a group title. Then the pages of the chapter are the links under the group title.
- If the first page of a chapter is the page of the chapter itself, put its number first.
- Use the text of the links and of the group titles as titles. Do not invent titles.
- The title of the book is the name of the book or of the documentation, with no site name or slogan.
- Answer with the numbers of the links.`;

const TocAnswer = z.object({
  title: z.string(),
  chapters: z.array(z.object({ title: z.string(), links: z.array(z.number().int()) })),
});

export async function tocFromLinks(
  llm: LlmClient,
  page: { title: string; url: string },
  items: LinkItem[],
): Promise<{ title: string; chapters: WebChapter[] }> {
  const minDepth = Math.min(...items.map((item) => item.depth));
  const origin = new URL(page.url).origin;
  const lines = items.map((item, i) => {
    const indent = "  ".repeat(item.depth - minDepth);
    if (item.url === null) return `${i + 1}: ${indent}[group] ${item.text}`;
    const path = item.url.startsWith(origin) ? item.url.slice(origin.length) : item.url;
    return `${i + 1}: ${indent}${item.text} -> ${path}`;
  });
  const answer = await llm.object({
    system: TOC_SYSTEM,
    prompt: `The title of the page: ${page.title || "none"}\nThe address of the page: ${page.url}\n\nThe items:\n${lines.join("\n")}`,
    schema: TocAnswer,
  });

  const seen = new Set<string>();
  const chapters: WebChapter[] = [];
  for (const chapter of answer.chapters) {
    const pages: WebPage[] = [];
    for (const number of chapter.links) {
      const item = items[number - 1];
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      pages.push({ title: item.text, url: item.url });
    }
    if (pages.length > 0) chapters.push({ title: normalizeSpace(chapter.title) || pages[0]!.title, pages });
  }
  return { title: normalizeSpace(answer.title) || page.title, chapters };
}

export interface FindTocOptions {
  startUrl: string;
  // A page with the full list of links. With this page, the search for llms.txt does not run.
  tocUrl?: string;
  download: Downloader;
  // The model client. The function throws an error if .env has no model. Only an HTML table of contents needs the model.
  llm: () => LlmClient;
  log?: (line: string) => void;
}

function isLlmsTxt(status: number, text: string): boolean {
  return status === 200 && !/^\s*</.test(text) && text.split(/\r?\n/).some((line) => LIST_LINK.test(line));
}

async function getText(download: Downloader, url: string): Promise<{ url: string; status: number; text: string } | null> {
  try {
    const result = await download.get(url);
    return { url: result.url, status: result.status, text: bodyText(result) };
  } catch (error) {
    if (error instanceof RobotsError) return null;
    throw error;
  }
}

// Find the table of contents: first in an llms.txt file, then in the links of the start page or of the --toc page.
export async function findToc(options: FindTocOptions): Promise<WebToc> {
  const { startUrl, download } = options;
  const log = options.log ?? (() => {});

  if (!options.tocUrl) {
    for (const url of llmsTxtUrls(startUrl)) {
      const file = await getText(download, url).catch(() => null);
      if (!file || !isLlmsTxt(file.status, file.text)) continue;
      const parsed = parseLlmsTxt(file.text, file.url);
      const urls = parsed.groups.flatMap((group) => group.links.map((link) => link.url));
      const scope = scopeOf(startUrl, urls);
      const chapters = llmsChapters(parsed, scope);
      if (chapters.length === 0) {
        log(`${url} has no pages in ${scope}.`);
        continue;
      }
      log(`The table of contents comes from ${url}.`);
      return { title: parsed.title || new URL(startUrl).host, language: "en", startUrl, source: "llms.txt", tocUrl: url, scope, chapters };
    }
    log("The site has no llms.txt file. The table of contents comes from the links of the start page.");
  }

  const tocUrl = options.tocUrl ?? startUrl;
  const page = await getText(download, tocUrl);
  if (!page) throw new TocError(`robots.txt disallows ${tocUrl}.`);
  if (page.status !== 200) throw new TocError(`${tocUrl} gave the HTTP status ${page.status}.`);
  const links = collectLinks(page.text, page.url);
  for (const frame of links.frames) {
    const framePage = await getText(download, frame).catch(() => null);
    if (framePage?.status === 200) links.items.push(...collectLinks(framePage.text, framePage.url).items);
  }
  const start = options.tocUrl ? startUrl : page.url;
  const urls = links.items.flatMap((item) => (item.url ? [item.url] : []));
  const scope = scopeOf(start, urls);
  const items = scopedItems(links.items, scope);
  if (!items.some((item) => item.url !== null)) {
    throw new TocError(`${tocUrl} has no links to pages in ${scope}. Add --toc <url> with a page that lists the pages.`);
  }

  const llm = options.llm();
  log(`One model request finds the table of contents in ${items.length} links and group titles.`);
  const toc = await tocFromLinks(llm, { title: links.title, url: page.url }, items);
  if (toc.chapters.length === 0) {
    throw new TocError(`The model found no table of contents in ${tocUrl}. Add --toc <url> with a page that lists the pages.`);
  }
  return { title: toc.title, language: links.language ?? "en", startUrl: start, source: "html", tocUrl: page.url, scope, chapters: toc.chapters };
}

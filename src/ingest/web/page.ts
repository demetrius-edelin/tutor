import * as cheerio from "cheerio";
import render from "dom-serializer";
import { isTag, type AnyNode, type Element } from "domhandler";
import { marked } from "marked";
import { blockText, CALLOUT_CLASS, descendants, localName, type Doc } from "../core/dom.js";
import { countWords, normalizeSpace } from "../core/text.js";
import { absoluteUrl } from "./toc.js";

// Elements with no text of the page: menus, scripts, forms, and media that the parser cannot read.
const REMOVED = new Set([
  "nav", "script", "style", "noscript", "template", "button", "form", "input", "select", "textarea", "label",
  "iframe", "svg", "footer", "link", "meta", "dialog", "object", "embed", "canvas", "video", "audio", "source",
]);
const KEPT_ATTRIBUTES = new Set(["id", "href", "src", "alt", "title", "role", "data-lang", "colspan", "rowspan", "start", "lang"]);
// The parser reads a class for the language of code, and for boxes such as notes. Other classes of a site can look
// like heading classes of a publisher, so they go.
const CODE_ELEMENTS = new Set(["pre", "code"]);
const BOX_ELEMENTS = new Set(["div", "section", "aside", "blockquote"]);
const HEADING = /^h([1-6])$/;
const UNWRAPPED_IN_HEADING = new Set(["div", "p", "section", "header"]);

export function isMarkdown(url: string, contentType: string): boolean {
  if (contentType.includes("markdown")) return true;
  return /\.(md|markdown)$/i.test(new URL(url).pathname) && !contentType.includes("html");
}

// MDX pages contain component tags such as <Stepper> or <Callout type="info" />. Remove these tags, and keep their content.
// The code blocks do not change. MDX import and export lines go too.
export function stripMdx(markdown: string): string {
  return markdown
    .split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/^(import|export)\s.*$/gm, "")
            .replace(/<\/?[A-Z][\w.]*(?:\s[^<>]*?)?\/?>/g, ""),
    )
    .join("");
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(stripMdx(markdown), { async: false, gfm: true });
}

function textLength($: Doc, element: Element): number {
  return normalizeSpace($(element).text()).length;
}

// The element with the content: <main>, then <article>, then <body>. If there are more, the one with the most text.
function contentRoot($: Doc): Element | null {
  for (const selector of ["main, [role=main]", "article"]) {
    const candidates = $(selector).toArray().filter(isTag);
    if (candidates.length > 0) return candidates.reduce((best, element) => (textLength($, element) > textLength($, best) ? element : best));
  }
  return $("body").toArray().filter(isTag)[0] ?? null;
}

// A comparable form of a title: lower case, with no numbering such as "4.1." and no punctuation.
function titleKey(text: string): string {
  return normalizeSpace(text.toLowerCase().replace(/^[\s\d.]+(?=\D)/, "").replace(/[^\p{L}\p{N}]+/gu, " "));
}

export interface PageLayout {
  // The prefix for the ids of the page, for example "p12". The ids of two pages in one file must not be the same.
  prefix: string;
  // The titles of the page in the table of contents. If the first heading of the page has one of these titles, the heading goes.
  titles: string[];
  // The level of the highest heading in the page content, after the change.
  headingBase: number;
}

export interface CleanPage {
  // The addresses of the images, in page order.
  images: string[];
  // The content as XHTML. Each image gets the src from the map, or keeps its address.
  render(imageSrc: ReadonlyMap<string, string>): string;
  // The text of the content, with normal spaces.
  text: string;
  words: number;
}

// Clean the HTML of a page for the EPUB file.
// - Keep the content element, and remove the elements with no text of the page.
// - Remove the first heading if it repeats the title. Move the other headings to the base level and lower.
// - Make links and images absolute, and add the prefix to the ids.
export function cleanPage(html: string, url: string, layout: PageLayout): CleanPage {
  const $ = cheerio.load(html);
  const root = contentRoot($);
  if (!root) return { images: [], render: () => "", text: "", words: 0 };

  for (const element of descendants($, root)) {
    if (REMOVED.has(localName(element)) || element.attribs.hidden !== undefined) $(element).remove();
  }
  const elements = descendants($, root);

  // A link to a place in the page with no letters or digits is an anchor mark, for example "#" or "¶" next to a heading.
  for (const element of elements.filter((item) => localName(item) === "a")) {
    const href = element.attribs.href ?? "";
    if (href.startsWith("#") && !/[\p{L}\p{N}]/u.test(blockText(element))) $(element).remove();
  }

  // A heading keeps only inline content. A <div> in a heading breaks the heading line in Markdown.
  for (const element of descendants($, root).filter((item) => HEADING.test(localName(item)))) {
    for (const block of descendants($, element).filter((item) => UNWRAPPED_IN_HEADING.has(localName(item)))) {
      $(block).replaceWith($(block).contents());
    }
  }

  // A code block keeps its lines.
  for (const element of descendants($, root).filter((item) => localName(item) === "br" && $(item).closest("pre").length > 0)) {
    $(element).replaceWith("\n");
  }

  const headings = descendants($, root).filter((element) => HEADING.test(localName(element)));
  const first = headings[0];
  if (first && layout.titles.some((title) => titleKey(title) === titleKey(blockText(first)))) {
    $(first).remove();
    headings.shift();
  }
  // The first heading goes to the base level, and the other headings move with it. A heading above the first heading
  // also goes to the base level. For example, a page with <h3> sections and an <h2> "Summary" at the end gets the same level for all of them.
  if (headings.length > 0) {
    const top = Number(HEADING.exec(localName(headings[0]!))![1]);
    for (const element of headings) {
      const level = Number(HEADING.exec(localName(element))![1]);
      element.name = `h${Math.min(6, Math.max(layout.headingBase, level - top + layout.headingBase))}`;
    }
  }

  const images: string[] = [];
  for (const element of descendants($, root)) {
    const name = localName(element);
    if (name === "img") {
      const src = [element.attribs.src, element.attribs["data-src"], element.attribs["data-lazy-src"], element.attribs.srcset?.split(/[\s,]+/)[0]]
        .find((value) => value && !value.startsWith("data:"));
      const address = src ? absoluteUrl(src, url) : null;
      if (address) {
        element.attribs.src = address;
        if (!images.includes(address)) images.push(address);
      } else {
        delete element.attribs.src;
      }
    }
    const className = element.attribs.class ?? "";
    for (const attribute of Object.keys(element.attribs)) {
      if (!KEPT_ATTRIBUTES.has(attribute)) delete element.attribs[attribute];
    }
    if (CODE_ELEMENTS.has(name) || (BOX_ELEMENTS.has(name) && CALLOUT_CLASS.test(className))) {
      if (className) element.attribs.class = className;
    }
    if (element.attribs.id) element.attribs.id = `${layout.prefix}-${element.attribs.id}`;
    if (name === "a" && element.attribs.href !== undefined) {
      const href = element.attribs.href;
      if (href.startsWith("#")) {
        element.attribs.href = `#${layout.prefix}-${href.slice(1)}`;
      } else {
        const address = absoluteUrl(href, url);
        if (address) element.attribs.href = `${address}${href.includes("#") ? href.slice(href.indexOf("#")) : ""}`;
        else delete element.attribs.href;
      }
    }
  }

  const text = normalizeSpace(blockText(root));
  return {
    images,
    text,
    words: countWords(text),
    render(imageSrc) {
      for (const element of descendants($, root).filter((item) => localName(item) === "img")) {
        const local = element.attribs.src ? imageSrc.get(element.attribs.src) : undefined;
        if (local) element.attribs.src = local;
      }
      return (root.children as AnyNode[]).map((node) => render(node, { xmlMode: true })).join("");
    },
  };
}

// Clean a Markdown page: convert it to HTML first.
export function cleanMarkdownPage(markdown: string, url: string, layout: PageLayout): CleanPage {
  return cleanPage(`<html><body>${markdownToHtml(markdown)}</body></html>`, url, layout);
}

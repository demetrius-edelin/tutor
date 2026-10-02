import TurndownService from "turndown";
import gfmPlugin from "turndown-plugin-gfm";
import type { Element } from "domhandler";
import {
  CALLOUT_CLASS,
  CALLOUT_TYPES,
  descendants,
  FOOTNOTE_TYPES,
  isCallout,
  loadFragment,
  localName,
  semanticTypes,
  type Doc,
} from "./dom.js";
import { escapeHtml, normalizeSpace } from "./text.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
});
turndown.use(gfmPlugin.gfm);

// Write each code block as a fenced block with the text of the code, also without a <code> element.
turndown.addRule("preformatted", {
  filter: "pre",
  replacement: (_content, node) => {
    const pre = node as HTMLElement;
    const code = (pre.textContent ?? "").replace(/\n+$/, "");
    const fence = code.includes("```") ? "~~~~" : "```";
    return `\n\n${fence}${codeLanguage(pre)}\n${code}\n${fence}\n\n`;
  },
});

// Placeholders, for example "[Image: diagram]", go into the Markdown without escape characters.
turndown.addRule("placeholder", {
  filter: (node) => node.nodeName === "SPAN" && node.hasAttribute("data-placeholder"),
  replacement: (_content, node) => (node as HTMLElement).getAttribute("data-placeholder") ?? "",
});

function codeLanguage(pre: HTMLElement): string {
  for (const element of [pre.querySelector("code"), pre]) {
    if (!element) continue;
    const language = element.getAttribute("data-lang");
    if (language) return language;
    const match = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(element.getAttribute("class") ?? "");
    if (match?.[1]) return match[1];
  }
  return "";
}

function placeholder(text: string): string {
  // The span needs text. Turndown removes empty elements before it uses the rules.
  return `<span data-placeholder="${escapeHtml(text)}">${escapeHtml(text)}</span>`;
}

function calloutLabel(element: Element, types: string[]): string | null {
  if (types.some((type) => FOOTNOTE_TYPES.has(type))) return "Footnote";
  if (!isCallout(element)) return null;
  const title = normalizeSpace(element.attribs.title ?? "");
  if (title && title.length <= 100) return title;
  const keyword = CALLOUT_CLASS.exec(element.attribs.class ?? "")?.[1] ?? types.find((type) => CALLOUT_TYPES.has(type));
  if (!keyword || /admonition|notice|callout/i.test(keyword)) return "Note";
  return keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase();
}

function simplify($: Doc): void {
  $("[data-page]").remove();

  for (const link of descendants($).filter((element) => localName(element) === "a")) {
    if (semanticTypes(link).includes("noteref")) {
      $(link).replaceWith(placeholder(`[${normalizeSpace($(link).text())}]`));
    }
  }
  for (const image of descendants($).filter((element) => ["img", "svg", "image"].includes(localName(element)))) {
    const alt = normalizeSpace(image.attribs.alt ?? "");
    const useful = alt && !/\.(png|jpe?g|gif|svg|webp)$/i.test(alt);
    $(image).replaceWith(placeholder(useful ? `[Image: ${alt}]` : "[Image]"));
  }
  for (const caption of descendants($).filter((element) => localName(element) === "figcaption")) {
    $(caption).replaceWith(`<p><em>${escapeHtml(normalizeSpace($(caption).text()))}</em></p>`);
  }
  // Keep external links. Keep only the text of internal links.
  for (const link of descendants($).filter((element) => localName(element) === "a")) {
    const href = link.attribs.href ?? "";
    if (/^https?:\/\//i.test(href)) {
      link.attribs = { href };
    } else {
      $(link).replaceWith($(link).contents());
    }
  }
  // Inner callouts first, so that an outer callout keeps the result.
  for (const element of descendants($).reverse()) {
    const label = calloutLabel(element, semanticTypes(element));
    if (!label) continue;
    $(element).replaceWith(`<blockquote><p><strong>${escapeHtml(label)}</strong></p>${$(element).html() ?? ""}</blockquote>`);
  }
  // A Markdown table cell is one line. Change the block elements in a cell into inline text.
  for (const cell of descendants($).filter((element) => ["td", "th"].includes(localName(element)))) {
    for (const block of descendants($, cell).reverse()) {
      if (!["p", "div", "ul", "ol", "li", "dl", "dt", "dd"].includes(localName(block))) continue;
      $(block).replaceWith(` ${$(block).html() ?? ""} `);
    }
  }
  for (const term of descendants($).filter((element) => localName(element) === "dt")) {
    $(term).replaceWith(`<p><strong>${$(term).html() ?? ""}</strong></p>`);
  }
  for (const definition of descendants($).filter((element) => localName(element) === "dd")) {
    $(definition).replaceWith(`<div>${$(definition).html() ?? ""}</div>`);
  }
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  const $ = loadFragment(html);
  simplify($);
  return turndown
    .turndown($.html())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

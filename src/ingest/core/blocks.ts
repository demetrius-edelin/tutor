import render from "dom-serializer";
import { isTag, isText, type Element } from "domhandler";
import { blockText, descendants, isCallout, loadXml, localName, semanticTypes, type Doc } from "./dom.js";
import { elementStyle, HEADING_MIN_SIZE, headingLevels, parseStylesheet, type StyleMap } from "./styles.js";
import { countWords, escapeHtml, normalizeSpace } from "./text.js";

// A block is one heading, one piece of content, or one page break.
// The parser puts all blocks of the book in one list, in reading order.
export interface Block {
  file: string;
  index: number;
  kind: "heading" | "content" | "pagebreak";
  // The heading level from 1 to 6. It is 0 for other blocks.
  level: number;
  text: string;
  words: number;
  // HTML for the Markdown conversion.
  html: string;
  // The element ids in the block, and the ids of containers that start just before it.
  anchors: string[];
  // The print page labels in the block, in order.
  pages: string[];
  // The semantic types of the containers around the block.
  types: string[];
}

const CONTAINERS = new Set(["body", "section", "div", "article", "main", "header", "footer", "hgroup"]);
const IGNORED = new Set(["script", "style", "noscript", "template", "nav", "head"]);
const HEADING = /^h([1-6])$/;
// A container with more words than this splits into its children, also without headings.
const LARGE_CONTAINER_WORDS = 400;

export function flattenXhtml(
  file: string,
  xhtml: string,
  startIndex: number,
  pageAnchors: Map<string, string>,
  styles: StyleMap = new Map(),
): Block[] {
  const $ = loadXml(xhtml);
  const body = descendants($).find((element) => localName(element) === "body");
  if (!body) return [];
  prepareBody($, body, withInlineStyles($, styles));

  const blocks: Block[] = [];
  const pendingAnchors: string[] = [];

  const scan = (root: Element) => {
    const anchors: string[] = [];
    const pages: string[] = [];
    for (const element of [root, ...descendants($, root)]) {
      const marker = element.attribs["data-page"];
      if (marker !== undefined && pages.at(-1) !== marker) pages.push(marker);
      const id = element.attribs.id;
      if (!id) continue;
      anchors.push(id);
      const label = pageAnchors.get(`${file}#${id}`);
      if (label !== undefined && pages.at(-1) !== label) pages.push(label);
    }
    return { anchors, pages };
  };

  const push = (
    kind: Block["kind"],
    level: number,
    element: Element | null,
    html: string,
    text: string,
    types: string[],
  ) => {
    const found = element ? scan(element) : { anchors: [], pages: [] };
    blocks.push({
      file,
      index: startIndex + blocks.length,
      kind,
      level,
      text,
      words: countWords(text),
      html,
      anchors: [...pendingAnchors, ...found.anchors],
      pages: found.pages,
      types,
    });
    pendingAnchors.length = 0;
  };

  const hasHeading = (element: Element) =>
    descendants($, element).some((child) => HEADING.test(localName(child)));

  const walk = (parent: Element, types: string[]) => {
    for (const node of parent.children) {
      if (isText(node)) {
        const text = normalizeSpace(node.data);
        if (text) push("content", 0, null, `<p>${escapeHtml(text)}</p>`, text, types);
        continue;
      }
      if (!isTag(node)) continue;
      const name = localName(node);
      if (IGNORED.has(name)) continue;
      if (node.attribs["data-page"] !== undefined) {
        push("pagebreak", 0, node, "", "", types);
        continue;
      }
      const heading = HEADING.exec(name);
      if (heading) {
        push("heading", Number(heading[1]), node, toHtml(node), normalizeSpace(blockText(node)), types);
        continue;
      }
      const large = () => !isCallout(node) && countWords(blockText(node)) > LARGE_CONTAINER_WORDS;
      if (CONTAINERS.has(name) && (hasHeading(node) || large())) {
        if (node.attribs.id) pendingAnchors.push(node.attribs.id);
        walk(node, [...types, ...semanticTypes(node)]);
        continue;
      }
      push("content", 0, node, toHtml(node), normalizeSpace(blockText(node)), types);
    }
  };

  walk(body, semanticTypes(body));
  // Anchors at the end of a file belong to the last block of the file.
  if (pendingAnchors.length > 0) blocks.at(-1)?.anchors.push(...pendingAnchors);
  return blocks;
}

// Add the rules of the <style> elements in the file to the styles of the book.
function withInlineStyles($: Doc, styles: StyleMap): StyleMap {
  const inline = descendants($).filter((element) => localName(element) === "style");
  if (inline.length === 0) return styles;
  const result: StyleMap = new Map(styles);
  for (const element of inline) parseStylesheet($(element).text(), result);
  return result;
}

const HEADING_CLASS =
  /^(h[1-6][a-z]?|hd[1-6]?|heading[1-6]?|title|subtitle|sub-?head(ing)?[1-6]?|chapter-?title|section-?title|ct[0-9]?|cn)$/i;
const BLOCK_ELEMENTS = new Set(["p", "div", "ul", "ol", "table", "figure", "blockquote", "section", "aside", "dl", "pre"]);
const INLINE_ELEMENTS = new Set(["span", "font", "small", "big"]);

// Prepare the body for the parse:
// - Remove scripts and styles.
// - Change each page break into an empty marker, so that the page number does not go into the text.
// - Change a short paragraph with a large font or a heading class into a real heading.
// - Change an inline element with a bold or italic class into <strong> or <em>.
function prepareBody($: Doc, body: Element, styles: StyleMap): void {
  for (const element of descendants($, body)) {
    if (["script", "style", "noscript", "template"].includes(localName(element))) $(element).remove();
  }
  for (const element of descendants($, body)) {
    if (!semanticTypes(element).includes("pagebreak")) continue;
    const label =
      normalizeSpace(element.attribs.title ?? element.attribs["aria-label"] ?? $(element).text()) ||
      (element.attribs.id ?? "").replace(/^\D+/, "");
    const id = element.attribs.id ? ` id="${escapeHtml(element.attribs.id)}"` : "";
    $(element).replaceWith(`<span data-page="${escapeHtml(label)}"${id}></span>`);
  }

  const levels = headingLevels(styles);
  const levelForSize = (size: number) =>
    levels.get(size) ?? Math.min(6, [...levels.keys()].filter((other) => other > size).length + 1);
  for (const element of descendants($, body)) {
    const name = localName(element);
    if (name !== "p" && name !== "div") continue;
    if ($(element).parents().toArray().some((parent) => ["li", "table", "aside", "blockquote", "figure", "dl"].includes(localName(parent)))) continue;
    if (descendants($, element).some((child) => BLOCK_ELEMENTS.has(localName(child)))) continue;
    const text = normalizeSpace($(element).text());
    const words = countWords(text);
    if (words === 0 || words > 15 || text.length > 150) continue;
    const style = elementStyle(styles, element.attribs.class, element.attribs.style);
    const classes = (element.attribs.class ?? "").split(/\s+/).filter(Boolean);
    if ((style.fontSize ?? 0) >= HEADING_MIN_SIZE) {
      element.name = `h${levelForSize(style.fontSize!)}`;
    } else if (classes.some((name) => HEADING_CLASS.test(name))) {
      element.name = `h${Math.min(6, levels.size + 1)}`;
    }
  }

  for (const element of descendants($, body)) {
    if (!INLINE_ELEMENTS.has(localName(element))) continue;
    const style = elementStyle(styles, element.attribs.class, element.attribs.style);
    if (style.bold && style.italic) {
      element.name = "strong";
      $(element).wrapInner("<em></em>");
    } else if (style.bold) {
      element.name = "strong";
    } else if (style.italic) {
      element.name = "em";
    }
  }
}

// Serialize as HTML, not XML. An HTML parser reads <a id="x"/> as an open tag,
// so the XML form can put the text that follows into the link.
function toHtml(element: Element): string {
  return render(element, { xmlMode: false, decodeEntities: true });
}

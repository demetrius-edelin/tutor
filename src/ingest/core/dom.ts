import * as cheerio from "cheerio";
import { isTag, isText, type AnyNode, type Element } from "domhandler";
import { decodeHTML } from "entities";

export type Doc = cheerio.CheerioAPI;

const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

// XHTML files can use HTML entities such as &nbsp;. An XML parser does not know them,
// so change them to numeric references before the parse.
export function prepareXhtml(xhtml: string): string {
  return xhtml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => {
    if (XML_ENTITIES.has(name)) return match;
    const decoded = decodeHTML(match);
    if (decoded === match) return match;
    return [...decoded].map((char) => `&#${char.codePointAt(0)};`).join("");
  });
}

export function loadXml(xml: string): Doc {
  return cheerio.load(prepareXhtml(xml), { xml: true });
}

export function loadFragment(html: string): Doc {
  return cheerio.load(html, null, false);
}

// The element name without a namespace prefix, in lower case.
export function localName(element: Element): string {
  const name = element.name;
  const colon = name.indexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

export function childElements(node: AnyNode): Element[] {
  return "children" in node ? node.children.filter(isTag) : [];
}

export function descendants($: Doc, root?: AnyNode): Element[] {
  return (root ? $(root) : $.root()).find("*").toArray();
}

export function elementsNamed($: Doc, name: string, root?: AnyNode): Element[] {
  return descendants($, root).filter((element) => localName(element) === name);
}

export const CALLOUT_CLASS = /\b(admonition|note|tip|warning|caution|important|sidebar|callout|notice|hint)\b/i;
export const CALLOUT_TYPES = new Set(["notice", "note", "tip", "warning", "caution", "important", "sidebar", "help"]);
export const FOOTNOTE_TYPES = new Set(["footnote", "endnote", "rearnote"]);

// A callout is a box such as a note, a tip, a sidebar, or a footnote.
export function isCallout(element: Element): boolean {
  const types = semanticTypes(element);
  if (types.some((type) => CALLOUT_TYPES.has(type) || FOOTNOTE_TYPES.has(type))) return true;
  const name = localName(element);
  return name === "aside" || (["div", "section"].includes(name) && CALLOUT_CLASS.test(element.attribs.class ?? ""));
}

const BLOCK_TEXT_ELEMENTS = new Set([
  "p", "div", "li", "ul", "ol", "table", "tr", "td", "th", "thead", "tbody", "tfoot", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6", "br", "dt", "dd", "dl", "figcaption", "figure", "blockquote",
  "pre", "section", "aside", "header", "footer", "hr",
]);

// The text of a node, with a space at each block element boundary.
// The text() function of cheerio joins "<td>a</td><td>b</td>" into "ab".
export function blockText(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (!isTag(node)) return "";
  const inner = node.children.map(blockText).join("");
  return BLOCK_TEXT_ELEMENTS.has(localName(node)) ? ` ${inner} ` : inner;
}

// The semantic types of an element: the epub:type values and the DPUB-ARIA roles.
export function semanticTypes(element: Element): string[] {
  const types = (element.attribs["epub:type"] ?? "").toLowerCase().split(/\s+/);
  const roles = (element.attribs.role ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((role) => role.startsWith("doc-"))
    .map((role) => role.slice(4));
  return [...types, ...roles].filter(Boolean);
}

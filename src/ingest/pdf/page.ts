import { escapeHtml, normalizeSpace } from "../core/text.js";

// Turn the structure tags and the text of one PDF page into XHTML.
// The core then reads the XHTML as it reads an EPUB file.

export interface FontStyle {
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export interface PdfTextItem {
  str: string;
  // The baseline position, in PDF units. The y axis goes up from the bottom of the page.
  x: number;
  y: number;
  width: number;
  height: number;
  // The font size.
  size: number;
  font: FontStyle;
  // The marked content id that connects the text to a structure element.
  mcid: string | null;
  // Running headers, footers, and page numbers are artifacts.
  artifact: boolean;
}

export interface StructContent {
  type: string;
  id: string;
}

export interface StructNode {
  role: string;
  alt?: string;
  children?: (StructNode | StructContent)[];
}

export interface OutlineAnchor {
  id: string;
  // The top of the destination, or null for the top of the page.
  top: number | null;
}

export interface PageInput {
  tree: StructNode | null;
  items: PdfTextItem[];
  // The print page label, or null.
  label: string | null;
  anchors: OutlineAnchor[];
}

export interface PageResult {
  xhtml: string;
  // Text that is not an artifact and has no structure tag.
  untaggedItems: number;
}

const isNode = (child: StructNode | StructContent): child is StructNode => "role" in child;

const CONTAINER_ROLES = new Set(["Root", "Document", "Part", "Sect", "Div", "Art", "NonStruct", "Private", "TOC", "Index"]);
const INLINE_ROLES = new Set([
  "Span", "Link", "Reference", "Quote", "Em", "Strong", "Annot", "BibEntry", "Sub", "Ruby", "Warichu", "Lbl",
]);
const BULLET = /^[•●◦▪■□‣⁃·∙○◆◇►▸➢✓✔*–—-]\s*/u;

function headingLevel(role: string): number | null {
  const match = /^H([1-6])$/.exec(role);
  if (match) return Number(match[1]);
  if (role === "Title") return 1;
  if (role === "H") return 2;
  return null;
}

// The text items of a node and its inline children, in structure order.
function inlineItems(node: StructNode, byMcid: Map<string, PdfTextItem[]>): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  for (const child of node.children ?? []) {
    if (isNode(child)) items.push(...inlineItems(child, byMcid));
    else if (child.type === "content") items.push(...(byMcid.get(child.id) ?? []));
  }
  return items;
}

function hasBlockChild(node: StructNode): boolean {
  return (node.children ?? []).some((child) => isNode(child) && !INLINE_ROLES.has(child.role));
}

function topOf(items: PdfTextItem[]): number | null {
  if (items.length === 0) return null;
  return Math.max(...items.map((item) => item.y + (item.height || item.size)));
}

const visible = (items: PdfTextItem[]) => items.filter((item) => item.str.trim() !== "");

function isCodeRun(items: PdfTextItem[]): boolean {
  const text = visible(items);
  return text.length > 0 && text.every((item) => item.font.mono);
}

// A drop cap is one large capital letter at the start of a paragraph, for example "D" + "atabase".
function splitDropCap(items: PdfTextItem[]): { cap: string; rest: PdfTextItem[] } {
  const text = visible(items);
  if (text.length < 2) return { cap: "", rest: items };
  const sizes = text.map((item) => item.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)]!;
  const cap = text.find((item) => /^\p{Lu}$/u.test(item.str.trim()) && item.size >= median * 1.8);
  if (!cap) return { cap: "", rest: items };
  return { cap: cap.str.trim(), rest: items.filter((item) => item !== cap) };
}

// True if a space separates two consecutive items: a new line, or a gap between them.
function spaceBetween(previous: PdfTextItem, item: PdfTextItem): boolean {
  if (/\s$/.test(previous.str) || /^\s/.test(item.str)) return false;
  const newLine = Math.abs(item.y - previous.y) > previous.size * 0.5;
  return newLine || item.x - (previous.x + previous.width) > previous.size * 0.2;
}

// The plain text of items, with the same spaces as the rendered text.
export function plainText(items: PdfTextItem[]): string {
  let text = "";
  let previous: PdfTextItem | null = null;
  for (const item of items) {
    if (item.str === "") {
      text += " ";
      continue;
    }
    if (previous && spaceBetween(previous, item)) text += " ";
    text += item.str;
    previous = item;
  }
  return text;
}

// Join text items into one line of text. A new line or a gap between items becomes a space.
function joinText(items: PdfTextItem[], format: boolean): string {
  let html = "";
  let open: FontStyle | null = null;
  let previous: PdfTextItem | null = null;
  const close = () => {
    if (!open) return;
    if (open.mono) html += "</code>";
    if (open.italic) html += "</em>";
    if (open.bold) html += "</strong>";
    open = null;
  };
  for (const item of items) {
    if (item.str === "") {
      if (previous && !/\s$/.test(html)) html += " ";
      continue;
    }
    if (previous && spaceBetween(previous, item)) {
      close();
      html += " ";
    }
    const style = format ? item.font : { bold: false, italic: false, mono: false };
    const same = open && open.bold === style.bold && open.italic === style.italic && open.mono === style.mono;
    if (!same && item.str.trim() !== "") {
      close();
      if (style.bold || style.italic || style.mono) {
        if (style.bold) html += "<strong>";
        if (style.italic) html += "<em>";
        if (style.mono) html += "<code>";
        open = style;
      }
    }
    html += escapeHtml(item.str);
    previous = item;
  }
  close();
  return html
    .replace(/\s+/g, " ")
    .replace(/<(strong|em|code)>(\s*)<\/\1>/g, "$2")
    .trim();
}

function inlineHtml(items: PdfTextItem[], format = true): string {
  const { cap, rest } = splitDropCap(items);
  const text = joinText(rest, format);
  return cap ? `${escapeHtml(cap)}${text}` : text;
}

// Split code items into lines, and keep the indentation of each line.
function codeLines(items: PdfTextItem[]): { x: number; text: string; size: number }[] {
  const lines: { x: number; y: number; size: number; parts: PdfTextItem[] }[] = [];
  for (const item of items) {
    const line = lines.at(-1);
    if (line && Math.abs(item.y - line.y) <= item.size * 0.5) line.parts.push(item);
    else lines.push({ x: item.x, y: item.y, size: item.size, parts: [item] });
  }
  return lines
    .map((line) => {
      let text = "";
      let end: number | null = null;
      for (const part of line.parts) {
        if (end !== null && part.x - end > part.size * 0.3 && !/\s$/.test(text) && !/^\s/.test(part.str)) text += " ";
        text += part.str;
        end = part.x + part.width;
      }
      return { x: line.x, text: text.replace(/\s+$/, ""), size: line.size };
    })
    .filter((line) => line.text.trim() !== "");
}

function codeBlock(lines: { x: number; text: string; size: number }[]): string {
  if (lines.length === 0) return "";
  const left = Math.min(...lines.map((line) => line.x));
  const text = lines
    .map((line) => " ".repeat(Math.max(0, Math.round((line.x - left) / (line.size * 0.6)))) + line.text)
    .join("\n");
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

interface PageBlock {
  node: StructNode;
  items: PdfTextItem[];
  top: number | null;
  // The outline anchors that point to this block.
  ids: string[];
}

// Collect the block elements under the containers, in structure order.
function collectBlocks(node: StructNode, byMcid: Map<string, PdfTextItem[]>, out: PageBlock[]): void {
  if (CONTAINER_ROLES.has(node.role)) {
    for (const child of node.children ?? []) {
      if (isNode(child)) collectBlocks(child, byMcid, out);
      else if (child.type === "content") {
        const items = byMcid.get(child.id) ?? [];
        if (visible(items).length > 0) out.push({ node: { role: "P", children: [child] }, items, top: topOf(items), ids: [] });
      }
    }
    return;
  }
  const items = allItems(node, byMcid);
  out.push({ node, items, top: topOf(items), ids: [] });
}

function allItems(node: StructNode, byMcid: Map<string, PdfTextItem[]>): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  for (const child of node.children ?? []) {
    if (isNode(child)) items.push(...allItems(child, byMcid));
    else if (child.type === "content") items.push(...(byMcid.get(child.id) ?? []));
  }
  return items;
}

function cleanAlt(alt: string | undefined): string {
  return normalizeSpace((alt ?? "").replace(/description automatically generated/i, ""));
}

// Render a list. Some PDFs put text directly in the list, outside the list items,
// for example a bold title. That text becomes a paragraph between two lists.
function renderList(node: StructNode, byMcid: Map<string, PdfTextItem[]>): string {
  let ordered = false;
  let entries: string[] = [];
  const out: string[] = [];
  const flushList = () => {
    if (entries.length === 0) return;
    const tag = ordered ? "ol" : "ul";
    out.push(`<${tag}>${entries.join("")}</${tag}>`);
    entries = [];
  };
  for (const child of node.children ?? []) {
    if (!isNode(child)) {
      if (child.type !== "content") continue;
      const html = inlineHtml(byMcid.get(child.id) ?? []);
      if (html) {
        flushList();
        out.push(`<p>${html}</p>`);
      }
      continue;
    }
    if (child.role === "L") {
      entries.push(`<li>${renderList(child, byMcid)}</li>`);
      continue;
    }
    if (child.role !== "LI") {
      flushList();
      out.push(renderBlock({ node: child, items: allItems(child, byMcid), top: null, ids: [] }, byMcid));
      continue;
    }
    const parts: string[] = [];
    for (const part of child.children ?? []) {
      if (!isNode(part)) {
        if (part.type === "content") parts.push(inlineHtml(byMcid.get(part.id) ?? []));
        continue;
      }
      if (part.role === "Lbl") {
        const label = inlineItems(part, byMcid).map((item) => item.str).join("").trim();
        if (/^\(?\w{1,3}[.)]$/.test(label)) ordered = true;
        continue;
      }
      parts.push(renderMixed(part, byMcid));
    }
    const html = stripBullet(parts.filter(Boolean).join(" "));
    if (html) entries.push(`<li>${html}</li>`);
  }
  flushList();
  return out.join("");
}

// Render a node that can hold inline text and block elements, for example a list body or a table cell.
function renderMixed(node: StructNode, byMcid: Map<string, PdfTextItem[]>): string {
  if (!hasBlockChild(node)) return stripBullet(inlineHtml(inlineItems(node, byMcid)));
  const parts: string[] = [];
  let run: PdfTextItem[] = [];
  const flush = () => {
    const html = stripBullet(inlineHtml(run));
    if (html) parts.push(`<p>${html}</p>`);
    run = [];
  };
  for (const child of node.children ?? []) {
    if (!isNode(child)) {
      if (child.type === "content") run.push(...(byMcid.get(child.id) ?? []));
    } else if (INLINE_ROLES.has(child.role)) {
      run.push(...inlineItems(child, byMcid));
    } else {
      flush();
      parts.push(renderBlock({ node: child, items: allItems(child, byMcid), top: null, ids: [] }, byMcid));
    }
  }
  flush();
  return parts.join("");
}

// Remove a bullet character at the start of the text, also after opening tags.
function stripBullet(html: string): string {
  const match = /^((?:<[^>]+>)*)(.*)$/s.exec(html)!;
  return match[1]! + match[2]!.replace(BULLET, "");
}

function renderTable(node: StructNode, byMcid: Map<string, PdfTextItem[]>): string {
  const rows: string[] = [];
  const visit = (current: StructNode) => {
    for (const child of current.children ?? []) {
      if (!isNode(child)) continue;
      if (child.role === "TR") {
        const cells = (child.children ?? [])
          .filter(isNode)
          .filter((cell) => cell.role === "TH" || cell.role === "TD")
          .map((cell) => {
            const tag = cell.role === "TH" ? "th" : "td";
            return `<${tag}>${renderMixed(cell, byMcid)}</${tag}>`;
          });
        rows.push(`<tr>${cells.join("")}</tr>`);
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return `<table>${rows.join("")}</table>`;
}

function renderBlock(block: PageBlock, byMcid: Map<string, PdfTextItem[]>): string {
  const { node, items } = block;
  const level = headingLevel(node.role);
  if (level) {
    const text = inlineHtml(items, false);
    return text ? `<h${level}>${text}</h${level}>` : "";
  }
  switch (node.role) {
    case "L":
      return renderList(node, byMcid);
    case "Table":
      return renderTable(node, byMcid);
    case "Figure": {
      const alt = cleanAlt(node.alt);
      const caption = visible(items).length > 0 ? `<figcaption>${inlineHtml(items)}</figcaption>` : "";
      return `<figure><img alt="${escapeHtml(alt)}"/>${caption}</figure>`;
    }
    case "Note":
      return `<aside epub:type="footnote">${renderMixed(node, byMcid)}</aside>`;
    case "Code":
      return codeBlock(codeLines(items));
    case "BlockQuote":
      return `<blockquote>${renderMixed(node, byMcid)}</blockquote>`;
    default: {
      if (hasBlockChild(node)) return `<div>${renderMixed(node, byMcid)}</div>`;
      const html = inlineHtml(inlineItems(node, byMcid));
      return html ? `<p>${html}</p>` : "";
    }
  }
}

interface Placeable {
  top: number | null;
  ids: string[];
}

// Give each outline destination to the block at the destination: the highest block that
// starts at or below the top of the destination. The function returns the anchors with no block.
function placeAnchors(blocks: Placeable[], anchors: OutlineAnchor[]): OutlineAnchor[] {
  const unplaced: OutlineAnchor[] = [];
  for (const anchor of anchors) {
    const target =
      anchor.top === null
        ? blocks[0]
        : blocks
            .filter((block) => block.top !== null && block.top <= anchor.top! + 4)
            .reduce<Placeable | undefined>((best, block) => (!best || block.top! > best.top! ? block : best), undefined);
    if (target) target.ids.push(anchor.id);
    else unplaced.push(anchor);
  }
  return unplaced;
}

export function pageToXhtml(input: PageInput): PageResult {
  const byMcid = new Map<string, PdfTextItem[]>();
  const untagged: PdfTextItem[] = [];
  for (const item of input.items) {
    if (item.artifact) continue;
    if (item.mcid === null) {
      if (item.str.trim()) untagged.push(item);
      continue;
    }
    const list = byMcid.get(item.mcid) ?? [];
    list.push(item);
    byMcid.set(item.mcid, list);
  }

  const blocks: PageBlock[] = [];
  if (input.tree) collectBlocks(input.tree, byMcid, blocks);

  // Merge consecutive paragraphs that are lines of code into one code block.
  type CodeEntry = { code: PdfTextItem[]; top: number | null; ids: string[] };
  const merged: (PageBlock | CodeEntry)[] = [];
  for (const block of blocks) {
    const isCode = block.node.role === "P" && isCodeRun(block.items);
    const last = merged.at(-1);
    if (isCode && last && "code" in last) last.code.push(...block.items);
    else if (isCode) merged.push({ code: [...block.items], top: block.top, ids: [] });
    else merged.push(block);
  }
  const unplaced = placeAnchors(merged, input.anchors);

  // An outline anchor is an empty element just before its block.
  const anchor = (id: string) => `<span id="${escapeHtml(id)}"/>`;
  const parts: string[] = [];
  if (input.label) parts.push(`<span epub:type="pagebreak" title="${escapeHtml(input.label)}"/>`);
  parts.push(...unplaced.map((item) => anchor(item.id)));
  for (const entry of merged) {
    parts.push(...entry.ids.map(anchor));
    parts.push("code" in entry ? codeBlock(codeLines(entry.code)) : renderBlock(entry, byMcid));
  }
  if (untagged.length > 0) parts.push(`<p>${inlineHtml(untagged)}</p>`);

  const xhtml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>` +
    parts.join("") +
    `</body></html>`;
  return { xhtml, untaggedItems: untagged.length };
}

import JSZip from "jszip";
import type { Element } from "domhandler";
import { flattenXhtml, type Block } from "../core/blocks.js";
import { childElements, elementsNamed, loadXml, localName, semanticTypes, type Doc } from "../core/dom.js";
import { resolveHref, type BookSource, type Landmark, type PageTarget, type TocEntry } from "../core/source.js";
import { parseStylesheet, type StyleMap } from "../core/styles.js";
import { normalizeSpace } from "../core/text.js";

export interface EpubPackage {
  title: string;
  authors: string[];
  // The content files in reading order, as paths in the ZIP file.
  spine: string[];
  toc: TocEntry[];
  tocSource: "nav" | "ncx" | "none";
  pageList: PageTarget[];
  landmarks: Landmark[];
  // The CSS files of the book.
  stylesheets: string[];
  readText(path: string): Promise<string>;
}

export async function openEpub(data: Uint8Array): Promise<EpubPackage> {
  const zip = await JSZip.loadAsync(data);
  const byLowerCase = new Map<string, string>();
  zip.forEach((path) => byLowerCase.set(path.toLowerCase(), path));

  const entryFor = (path: string) => zip.file(path) ?? zip.file(byLowerCase.get(path.toLowerCase()) ?? "");
  const exists = (path: string) => entryFor(path) !== null;
  const readText = async (path: string) => {
    const entry = entryFor(path);
    if (!entry) throw new Error(`The EPUB file does not contain "${path}".`);
    return entry.async("string");
  };

  const container = loadXml(await readText("META-INF/container.xml"));
  const opfPath = elementsNamed(container, "rootfile")[0]?.attribs["full-path"];
  if (!opfPath) throw new Error("The EPUB file has no package document.");
  const opf = loadXml(await readText(opfPath));

  const firstText = (name: string) => {
    const element = elementsNamed(opf, name)[0];
    return element ? normalizeSpace(opf(element).text()) : "";
  };
  const authors = elementsNamed(opf, "creator")
    .map((element) => normalizeSpace(opf(element).text()))
    .filter(Boolean);

  const manifest = new Map<string, { file: string; mediaType: string; properties: string[] }>();
  for (const item of elementsNamed(opf, "item")) {
    const { id, href } = item.attribs;
    if (!id || !href) continue;
    manifest.set(id, {
      file: resolveHref(opfPath, href).file,
      mediaType: item.attribs["media-type"] ?? "",
      properties: (item.attribs.properties ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const spine: string[] = [];
  for (const itemref of elementsNamed(opf, "itemref")) {
    const item = manifest.get(itemref.attribs.idref ?? "");
    if (!item || !/html/.test(item.mediaType) || !exists(item.file) || spine.includes(item.file)) continue;
    spine.push(item.file);
  }

  let toc: TocEntry[] = [];
  let tocSource: EpubPackage["tocSource"] = "none";
  let pageList: PageTarget[] = [];
  const landmarks: Landmark[] = [];

  const navItem = [...manifest.values()].find((item) => item.properties.includes("nav"));
  if (navItem && exists(navItem.file)) {
    const nav = parseNav(await readText(navItem.file), navItem.file);
    if (nav.toc.length > 0) {
      toc = nav.toc;
      tocSource = "nav";
    }
    pageList = nav.pageList;
    landmarks.push(...nav.landmarks);
  }

  const spineElement = elementsNamed(opf, "spine")[0];
  const ncxItem =
    manifest.get(spineElement?.attribs.toc ?? "") ??
    [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
  if (ncxItem && exists(ncxItem.file) && (toc.length === 0 || pageList.length === 0)) {
    const ncx = parseNcx(await readText(ncxItem.file), ncxItem.file);
    if (toc.length === 0 && ncx.toc.length > 0) {
      toc = ncx.toc;
      tocSource = "ncx";
    }
    if (pageList.length === 0) pageList = ncx.pageList;
  }

  // The EPUB 2 guide gives landmarks too.
  for (const reference of elementsNamed(opf, "reference")) {
    const { type, href } = reference.attribs;
    if (type && href) landmarks.push({ type: type.toLowerCase(), ...resolveHref(opfPath, href) });
  }

  const stylesheets = [...manifest.values()]
    .filter((item) => item.mediaType === "text/css" && exists(item.file))
    .map((item) => item.file);

  return {
    title: firstText("title") || "Untitled",
    authors,
    spine,
    toc,
    tocSource,
    pageList,
    landmarks,
    stylesheets,
    readText,
  };
}

function parseNav(xhtml: string, navFile: string) {
  const $ = loadXml(xhtml);
  const navs = elementsNamed($, "nav");
  const navOfType = (type: string) => navs.find((nav) => semanticTypes(nav).includes(type));

  const tocNav = navOfType("toc") ?? navs[0];
  const tocList = tocNav ? (elementsNamed($, "ol", tocNav)[0] ?? elementsNamed($, "ul", tocNav)[0]) : undefined;
  const toc = tocList ? navListEntries($, tocList, navFile) : [];

  const links = (nav: Element | undefined) =>
    nav ? elementsNamed($, "a", nav).filter((link) => link.attribs.href) : [];
  const pageList = links(navOfType("page-list")).map((link) => ({
    label: normalizeSpace($(link).text()),
    ...resolveHref(navFile, link.attribs.href!),
  }));
  const landmarks = links(navOfType("landmarks")).map((link) => ({
    type: semanticTypes(link).join(" "),
    ...resolveHref(navFile, link.attribs.href!),
  }));
  return { toc, pageList, landmarks };
}

function navListEntries($: Doc, list: Element, navFile: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const item of childElements(list).filter((element) => localName(element) === "li")) {
    const parts = childElements(item);
    const label = parts.find((element) => ["a", "span"].includes(localName(element)));
    const sublist = parts.find((element) => ["ol", "ul"].includes(localName(element)));
    const children = sublist ? navListEntries($, sublist, navFile) : [];
    const href = label?.attribs.href;
    const target = href ? resolveHref(navFile, href) : children[0];
    if (!target) continue;
    entries.push({
      title: normalizeSpace(label ? $(label).text() : "") || "Untitled",
      file: target.file,
      anchor: target.anchor,
      children,
    });
  }
  return entries;
}

function parseNcx(xml: string, ncxFile: string) {
  const $ = loadXml(xml);
  const childrenNamed = (element: Element, name: string) =>
    childElements(element).filter((child) => localName(child) === name);
  const labelOf = (element: Element) => {
    const label = childrenNamed(element, "navlabel")[0];
    return label ? normalizeSpace($(label).text()) : "";
  };

  const navPoint = (point: Element): TocEntry | null => {
    const children = childrenNamed(point, "navpoint")
      .map(navPoint)
      .filter((entry): entry is TocEntry => entry !== null);
    const src = childrenNamed(point, "content")[0]?.attribs.src;
    const target = src ? resolveHref(ncxFile, src) : children[0];
    if (!target) return null;
    return { title: labelOf(point) || "Untitled", file: target.file, anchor: target.anchor, children };
  };

  const navMap = elementsNamed($, "navmap")[0];
  const toc = navMap
    ? childrenNamed(navMap, "navpoint")
        .map(navPoint)
        .filter((entry): entry is TocEntry => entry !== null)
    : [];

  const pageList: PageTarget[] = [];
  for (const target of elementsNamed($, "pagetarget")) {
    const src = childrenNamed(target, "content")[0]?.attribs.src;
    if (src) pageList.push({ label: labelOf(target) || target.attribs.value || "", ...resolveHref(ncxFile, src) });
  }
  return { toc, pageList };
}

// Read an EPUB file into blocks and a table of contents.
export async function readEpub(data: Uint8Array): Promise<BookSource> {
  const epub = await openEpub(data);
  const pageAnchors = new Map<string, string>();
  for (const page of epub.pageList) if (page.anchor) pageAnchors.set(`${page.file}#${page.anchor}`, page.label);

  const styles: StyleMap = new Map();
  for (const file of epub.stylesheets) parseStylesheet(await epub.readText(file), styles);

  const blocks: Block[] = [];
  for (const file of epub.spine) {
    blocks.push(...flattenXhtml(file, await epub.readText(file), blocks.length, pageAnchors, styles));
  }
  return {
    format: "epub",
    title: epub.title,
    authors: epub.authors,
    tocSource: epub.tocSource,
    toc: epub.toc,
    landmarks: epub.landmarks,
    blocks,
    notes: [],
  };
}

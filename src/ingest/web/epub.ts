import JSZip from "jszip";
import { createHash } from "node:crypto";
import { escapeHtml } from "../core/text.js";

export interface EpubPage {
  // The id of the <section> element of the page, for example "p12".
  id: string;
  // The title of the page as an <h2> heading. Null for the page of the chapter itself, or for the page of a chapter with one page.
  heading: string | null;
  xhtml: string;
}

export interface EpubChapter {
  title: string;
  pages: EpubPage[];
}

export interface EpubImage {
  // The path in the EPUB file, relative to the content files, for example "images/3f2a9c0d1b7e4a55.png".
  path: string;
  mediaType: string;
  data: Uint8Array;
}

export interface EpubBook {
  title: string;
  author: string;
  language: string;
  // The start address of the site.
  source: string;
  date: Date;
  chapters: EpubChapter[];
  images: EpubImage[];
}

const chapterFile = (index: number) => `c${String(index + 1).padStart(3, "0")}.xhtml`;

function xhtmlDocument(title: string, language: string, body: string): string {
  const lang = escapeHtml(language);
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>
${body}
</body>
</html>
`;
}

// Write the book as an EPUB 3 file. Each chapter is one XHTML file. Each page is a <section> in the file of its chapter.
// The nav document lists the chapters and their pages. All pages of a chapter are in one file,
// so the parser makes one chapter and not a part with a chapter for each page.
export async function writeEpub(book: EpubBook): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
  );

  const navItems: string[] = [];
  book.chapters.forEach((chapter, i) => {
    const file = chapterFile(i);
    const sections = chapter.pages.map((page) => {
      const heading = page.heading ? `<h2>${escapeHtml(page.heading)}</h2>\n` : "";
      return `<section id="${page.id}">\n${heading}${page.xhtml}\n</section>`;
    });
    zip.file(`OEBPS/${file}`, xhtmlDocument(chapter.title, book.language, `<h1>${escapeHtml(chapter.title)}</h1>\n${sections.join("\n")}`));
    const children = chapter.pages
      .filter((page) => page.heading)
      .map((page) => `<li><a href="${file}#${page.id}">${escapeHtml(page.heading!)}</a></li>`);
    navItems.push(`<li><a href="${file}">${escapeHtml(chapter.title)}</a>${children.length > 0 ? `<ol>${children.join("")}</ol>` : ""}</li>`);
  });
  zip.file(
    "OEBPS/nav.xhtml",
    xhtmlDocument(book.title, book.language, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.join("\n")}</ol></nav>`),
  );
  for (const image of book.images) zip.file(`OEBPS/${image.path}`, image.data);

  const identifier = createHash("sha256").update(`${book.source}\n${book.title}\n${book.date.toISOString()}`).digest("hex").slice(0, 32);
  const modified = book.date.toISOString().replace(/\.\d+Z$/, "Z");
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...book.chapters.map((_, i) => `<item id="c${i + 1}" href="${chapterFile(i)}" media-type="application/xhtml+xml"/>`),
    ...book.images.map((image, i) => `<item id="i${i + 1}" href="${escapeHtml(image.path)}" media-type="${image.mediaType}"/>`),
  ];
  const spine = book.chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:tutor-fetch:${identifier}</dc:identifier>
    <dc:title>${escapeHtml(book.title)}</dc:title>
    <dc:creator>${escapeHtml(book.author)}</dc:creator>
    <dc:language>${escapeHtml(book.language)}</dc:language>
    <dc:source>${escapeHtml(book.source)}</dc:source>
    <dc:date>${book.date.toISOString().slice(0, 10)}</dc:date>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>
    ${spine.join("\n    ")}
  </spine>
</package>
`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

import { describe, expect, it } from "vitest";
import { flattenXhtml, type Block } from "../src/ingest/core/blocks.js";
import { buildBook } from "../src/ingest/core/book.js";
import type { BookSource } from "../src/ingest/core/source.js";
import { splitChapter } from "../src/ingest/core/structure.js";
import { htmlToMarkdown } from "../src/ingest/core/markdown.js";
import { bookLayout, layoutToXhtml, markRunningLines, type LayoutInput } from "../src/ingest/pdf/layout.js";
import { pageToXhtml, type FontStyle, type PdfTextItem, type StructNode } from "../src/ingest/pdf/page.js";
import { ImageKind, PermissionFlag } from "pdfjs-dist/legacy/build/pdf.mjs";
import { allowsCopy, attachImages, joinAcrossPages, joinLabels, pageFile, pixelsOf, styleOfFont, tocFromHeadings } from "../src/ingest/pdf/read.js";

const regular: FontStyle = { bold: false, italic: false, mono: false };
const bold: FontStyle = { ...regular, bold: true };
const italic: FontStyle = { ...regular, italic: true };
const mono: FontStyle = { ...regular, mono: true };

// A text item on a line. The y value goes down the page in steps of 20 units.
function item(mcid: string | null, str: string, line: number, options: Partial<PdfTextItem> = {}): PdfTextItem {
  return {
    str,
    x: 50,
    y: 700 - line * 20,
    width: str.length * 5,
    height: 11,
    size: 11,
    font: regular,
    mcid,
    artifact: false,
    ...options,
  };
}

const content = (id: string) => ({ type: "content", id });
const node = (role: string, ...children: StructNode["children"] & {}) => ({ role, children });

function markdownOf(xhtml: string, imageText: Map<string, string> = new Map()): string {
  return flattenXhtml("page-0001", xhtml, 0, new Map())
    .map((block) => htmlToMarkdown(block.html, imageText))
    .filter(Boolean)
    .join("\n\n");
}

describe("pageToXhtml", () => {
  it("renders headings, paragraphs, bold, italic, and inline code", () => {
    const tree = node("Root", node("Sect", node("H2", content("h")), node("P", content("p"))));
    const items = [
      item("h", "Question 1", 0, { font: bold, size: 14 }),
      item("p", "Use ", 1),
      item("p", "UNION", 1, { x: 80, font: bold }),
      item("p", " to join ", 1, { x: 110 }),
      item("p", "results", 1, { x: 160, font: italic }),
      item("p", " with ", 1, { x: 200 }),
      item("p", "SELECT", 1, { x: 230, font: mono }),
      item("p", ".", 1, { x: 260 }),
    ];
    const markdown = markdownOf(pageToXhtml({ tree, items, label: null, anchors: [] }).xhtml);
    expect(markdown).toContain("## Question 1");
    expect(markdown).toContain("Use **UNION** to join _results_ with `SELECT`.");
  });

  it("drops artifacts, joins the lines of a paragraph, and keeps a drop cap at the start", () => {
    const tree = node("Root", node("P", content("p")));
    const items = [
      item(null, "— 7 —", 30, { artifact: true }),
      item("p", "atabase and SQL are", 0, { x: 80 }),
      item("p", "D", 1, { size: 40, height: 40 }),
      item("p", "important skills.", 1, { x: 80 }),
    ];
    const markdown = markdownOf(pageToXhtml({ tree, items, label: "7", anchors: [] }).xhtml);
    expect(markdown).toBe("Database and SQL are important skills.");
  });

  it("merges lines of code into one code block and keeps the indentation", () => {
    const tree = node("Root", node("P", content("a")), node("P", content("b")), node("P", content("c")));
    const items = [
      item("a", "SELECT name", 0, { font: mono, x: 50 }),
      item("b", "FROM people", 1, { font: mono, x: 50 }),
      item("c", "WHERE age > 30;", 2, { font: mono, x: 63.2 }),
    ];
    const markdown = markdownOf(pageToXhtml({ tree, items, label: null, anchors: [] }).xhtml);
    expect(markdown).toBe("```\nSELECT name\nFROM people\n  WHERE age > 30;\n```");
  });

  it("renders lists without bullet characters, and keeps text that is directly in a list", () => {
    const tree = node(
      "Root",
      node(
        "L",
        content("title"),
        node("LI", node("Lbl", content("l1")), node("LBody", content("b1"))),
        node("LI", node("LBody", content("b2"))),
      ),
    );
    const items = [
      item("title", "2. UNION ALL:", 0, { font: bold }),
      item("l1", "•", 1),
      item("b1", "Keeps duplicates.", 1, { x: 70 }),
      item("b2", "• Is faster.", 2),
    ];
    const markdown = markdownOf(pageToXhtml({ tree, items, label: null, anchors: [] }).xhtml);
    expect(markdown).toContain("**2\\. UNION ALL:**");
    expect(markdown).toContain("-   Keeps duplicates.\n-   Is faster.");
  });

  it("renders tables with header cells", () => {
    const tree = node(
      "Root",
      node("Table", node("TR", node("TH", node("P", content("h1"))), node("TH", content("h2"))), node("TR", node("TD", content("d1")), node("TD", content("d2")))),
    );
    const items = [item("h1", "id", 0), item("h2", "name", 0, { x: 100 }), item("d1", "1", 1), item("d2", "John", 1, { x: 100 })];
    const markdown = markdownOf(pageToXhtml({ tree, items, label: null, anchors: [] }).xhtml);
    expect(markdown).toBe("| id | name |\n| --- | --- |\n| 1 | John |");
  });

  it("keeps the alternative text of a figure without the generated suffix", () => {
    const tree = node("Root", { role: "Figure", alt: "A black screen with white text\n\nDescription automatically generated", children: [] });
    const markdown = markdownOf(pageToXhtml({ tree, items: [], label: null, anchors: [] }).xhtml);
    expect(markdown).toBe("[Image: A black screen with white text]");
  });

  it("points a figure to its images, and puts the text of an image in its place", () => {
    const tree = node("Root", { role: "Figure", alt: "A black screen", images: ["a1", "b2"], children: [] }, node("P", content("after")));
    const items = [item("after", "The query finds the rows.", 3)];
    const xhtml = pageToXhtml({ tree, items, label: null, anchors: [] }).xhtml;
    expect(xhtml).toContain('<figure><img src="image:a1" alt="A black screen"/><img src="image:b2" alt="A black screen"/></figure>');
    const imageText = new Map([["a1", "_The tutor read this code from an image:_\n\n```sql\nSELECT 1;\n```"]]);
    expect(markdownOf(xhtml, imageText)).toBe(
      "_The tutor read this code from an image:_\n\n```sql\nSELECT 1;\n```\n\n[Image: A black screen]\n\nThe query finds the rows.",
    );
  });

  it("puts each outline anchor just before the block at its destination", () => {
    const tree = node("Root", node("P", content("intro")), node("H2", content("q18")), node("P", content("a18")), node("H2", content("q19")));
    const items = [
      item("intro", "End of the last question.", 0),
      item("q18", "Question 18", 2, { size: 14 }),
      item("a18", "Answer text.", 3),
      item("q19", "Question 19", 5, { size: 14 }),
    ];
    const anchors = [
      { id: "outline-1", top: 700 - 2 * 20 + 16 },
      { id: "outline-2", top: 700 - 5 * 20 + 16 },
    ];
    const blocks = flattenXhtml("page-0001", pageToXhtml({ tree, items, label: "9", anchors }).xhtml, 0, new Map());
    const position = (id: string) => blocks.findIndex((block) => block.anchors.includes(id));
    expect(blocks[position("outline-1") + 1]!.text).toBe("Question 18");
    expect(blocks[position("outline-2") + 1]!.text).toBe("Question 19");
    expect(blocks[0]!.pages).toEqual(["9"]);
  });

  it("adds untagged text at the end of the page and counts it", () => {
    const result = pageToXhtml({ tree: node("Root"), items: [item(null, "Loose text.", 0)], label: null, anchors: [] });
    expect(result.untaggedItems).toBe(1);
    expect(markdownOf(result.xhtml)).toBe("Loose text.");
  });
});

describe("PDF helpers", () => {
  it("reads bold, italic, and code fonts from the font name", () => {
    expect(styleOfFont({ name: "YHTKRC+MinionPro-Regular" })).toEqual(regular);
    expect(styleOfFont({ name: "SGUVLO+MinionPro-Bold" })).toEqual(bold);
    expect(styleOfFont({ name: "PMEYVU+MinionPro-BoldIt" })).toEqual({ ...bold, italic: true });
    expect(styleOfFont({ name: "FACQLO+MinionPro-It" })).toEqual(italic);
    expect(styleOfFont({ name: "SWQQLO+CourierNewPSMT" })).toEqual(mono);
  });

  it("joins a chapter label with the chapter name on the same page", () => {
    const entries = [
      { title: "CHAPTER 1:", page: 21, top: 600, children: [] },
      { title: "SQL Interview Questions", page: 21, top: 560, children: [{ title: "Question 1", page: 22, top: 340, children: [] }] },
      { title: "CHAPTER 2:", page: 40, top: 600, children: [] },
      { title: "Joins", page: 41, top: 600, children: [] },
    ];
    expect(joinLabels(entries).map((entry) => [entry.title, entry.page, entry.children.length])).toEqual([
      ["CHAPTER 1: SQL Interview Questions", 21, 1],
      ["CHAPTER 2:", 40, 0],
      ["Joins", 41, 0],
    ]);
  });

  it("joins a paragraph that continues on the next page", () => {
    const page = (file: string, html: string) => flattenXhtml(file, `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>${html}</body></html>`, 0, new Map());
    const blocks = [
      ...page("page-0001", "<p>The query reads the</p>"),
      ...page("page-0002", '<span epub:type="pagebreak" title="2"/><p>table once.</p><p>Next paragraph.</p>'),
    ];
    const joined = joinAcrossPages(blocks);
    expect(joined.filter((block) => block.kind === "content").map((block) => block.text)).toEqual([
      "The query reads the table once.",
      "Next paragraph.",
    ]);
    expect(joined.map((block) => block.index)).toEqual(joined.map((_, i) => i));
  });

  it("joins a code block that continues on the next page", () => {
    const page = (file: string, html: string) => flattenXhtml(file, `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>${html}</body></html>`, 0, new Map());
    const blocks = [
      ...page("page-0001", "<p>The loop:</p><pre><code>if (ready) {</code></pre>"),
      ...page("page-0002", '<span epub:type="pagebreak" title="2"/><pre><code>  start();\n}</code></pre><p>Next paragraph.</p>'),
    ];
    const code = joinAcrossPages(blocks).filter((block) => block.html.startsWith("<pre>"));
    expect(code).toHaveLength(1);
    expect(markdownOf(`<html><body>${code[0]!.html}</body></html>`)).toBe("```\nif (ready) {\n  start();\n}\n```");
  });
});

describe("section titles", () => {
  it("adds the bold question to a generic heading such as Question 1", () => {
    const xhtml = `<html><body><h1>Chapter</h1><p>Intro text of the chapter with enough words to stay.</p>
<h2>Question 1</h2><p><strong>Difference between UNION and UNION ALL</strong></p><p>Answer.</p>
<h2>Question 2</h2><p>No bold question here.</p></body></html>`;
    const blocks = flattenXhtml("c.xhtml", xhtml, 0, new Map());
    const titles = splitChapter("Chapter", blocks, { maxWords: 2500, minWords: 1 }).map((section) => section.title);
    expect(titles).toEqual(["Chapter", "Question 1: Difference between UNION and UNION ALL", "Question 2"]);
  });
});

describe("PDF images", () => {
  it("gives each figure the images of its marked content", () => {
    const figure: StructNode = { role: "Figure", children: [content("p12R_mc7"), content("p12R_mc9")] };
    const tree = node("Root", node("Sect", figure), node("P", content("p12R_mc8")));
    attachImages(tree, new Map([[7, "a1"], [8, "b2"], [9, "a1"]]));
    expect(figure.images).toEqual(["a1"]);
    expect((tree.children[1] as StructNode).images).toBeUndefined();
  });

  it("reads RGB, RGBA, and one-bit pixels", () => {
    const rgb = Uint8ClampedArray.from([1, 2, 3]);
    expect(pixelsOf({ width: 1, height: 1, kind: ImageKind.RGB_24BPP, data: rgb })).toEqual({ width: 1, height: 1, channels: 3, data: Uint8Array.from([1, 2, 3]) });
    expect(pixelsOf({ width: 1, height: 1, kind: ImageKind.RGBA_32BPP, data: Uint8Array.from([1, 2, 3, 4]) })?.channels).toBe(4);
    // Each row starts at a new byte. A set bit is white.
    const bits = Uint8Array.from([0b10100000, 0b01000000]);
    expect(pixelsOf({ width: 3, height: 2, kind: ImageKind.GRAYSCALE_1BPP, data: bits })).toEqual({
      width: 3,
      height: 2,
      channels: 1,
      data: Uint8Array.from([255, 0, 255, 0, 255, 0]),
    });
    expect(pixelsOf({ width: 1, height: 1, kind: 99, data: rgb })).toBeNull();
    expect(pixelsOf({})).toBeNull();
  });
});

describe("layout reader", () => {
  // A text item at a position. The y axis goes up from the bottom of the page.
  const at = (str: string, x: number, y: number, options: Partial<PdfTextItem> = {}): PdfTextItem => ({
    str,
    x,
    y,
    width: str.length * 5,
    height: 10,
    size: 10,
    font: regular,
    mcid: null,
    artifact: false,
    ...options,
  });
  const layout = { bodySize: 10, headingSizes: [18, 14] };
  const markdown = (items: PdfTextItem[], extra: Partial<LayoutInput> = {}) =>
    markdownOf(layoutToXhtml({ items, images: [], label: null, anchors: [], layout, ...extra }).xhtml);

  it("finds headings, paragraphs, inline code, lists, and code blocks in the layout", () => {
    const items = [
      at("Getting Started", 50, 700, { size: 18, font: bold }),
      at("Use the ", 50, 670),
      at("npm", 90, 670, { font: mono }),
      at(" command to install the pack-", 105, 670),
      at("age.", 50, 658),
      at("Next, run it:", 50, 640),
      at("if (ready) {", 50, 622, { size: 9, font: mono }),
      at("start();", 60, 611, { size: 9, font: mono }),
      at("}", 50, 600, { size: 9, font: mono }),
      at("•", 50, 580),
      at("First item", 62, 580),
      at("•", 50, 568),
      at("Second item", 62, 568),
    ];
    expect(markdown(items)).toBe(
      [
        "# Getting Started",
        "Use the `npm` command to install the package.",
        "Next, run it:",
        "```\nif (ready) {\n  start();\n}\n```",
        "-   First item\n-   Second item",
      ].join("\n\n"),
    );
  });

  it("keeps the spaces that are items of their own, and makes a short bold line a heading", () => {
    const items = [
      at("Loops", 50, 700, { font: bold }),
      at("Cache the", 50, 680),
      at(" ", 95, 680),
      at("length", 100, 680, { font: mono }),
      at(" ", 130, 680, { font: mono }),
      at("of the array.", 135, 680),
    ];
    expect(markdown(items)).toBe("### Loops\n\nCache the `length` of the array.");
  });

  it("reads two columns: the left column, then the right column", () => {
    const items = [at("A Title Across Both Columns", 50, 720, { size: 18, width: 500 })];
    for (let n = 0; n < 12; n++) {
      items.push(at(`left words ${n}`, 50, 680 - n * 12, { width: 200 }));
      items.push(at(`right words ${n}`, 320, 680 - n * 12, { width: 200 }));
    }
    const text = markdown(items);
    expect(text.startsWith("# A Title Across Both Columns")).toBe(true);
    expect(text.lastIndexOf("left")).toBeLessThan(text.indexOf("right"));
  });

  it("marks running heads, running feet, and page numbers, and keeps the body text", () => {
    const pages = [1, 2, 3, 4].map((n) => [
      at("Patterns in Practice", 50, 760),
      at(`Body text about topic ${"ABCD"[n - 1]} starts here.`, 50, 700),
      // The same text at the same place on each page, but not in the margin.
      at(`More body text on page ${n}.`, 50, 688),
      at(String(n + 10), 50, 40),
      at("Chapter 2: Essentials", 80, 40),
    ]);
    expect(markRunningLines(pages)).toEqual(["11", "12", "13", "14"]);
    for (const [n, items] of pages.entries()) {
      expect(items.filter((item) => item.artifact).map((item) => item.str)).toEqual(["Patterns in Practice", String(n + 11), "Chapter 2: Essentials"]);
    }
  });

  it("finds the body size and groups heading sizes that are almost the same", () => {
    const items = [
      at("x".repeat(500), 0, 0, { size: 10.2 }),
      at("code".repeat(200), 0, 0, { size: 8, font: mono }),
      at("Title", 0, 0, { size: 30 }),
      at("Title", 0, 0, { size: 29.7 }),
      at("Section", 0, 0, { size: 21.2 }),
    ];
    expect(bookLayout([items])).toEqual({ bodySize: 10, headingSizes: [29.5, 21] });
  });

  it("moves a bookmark from the title of a chapter to the label above it", () => {
    const items = [
      at("End of the last chapter.", 50, 740),
      at("CHAPTER 3", 50, 700, { size: 14, font: bold }),
      at("Literals", 50, 670, { size: 18, font: bold }),
      at("Text of the chapter.", 50, 640),
    ];
    const xhtml = layoutToXhtml({ items, images: [], label: null, anchors: [{ id: "outline-3", top: 690 }], layout }).xhtml;
    const blocks = flattenXhtml("page-0001", xhtml, 0, new Map());
    const position = blocks.findIndex((block) => block.anchors.includes("outline-3"));
    expect(blocks.slice(position).find((block) => block.kind === "heading")!.text).toBe("CHAPTER 3");
  });

  it("puts each image before the first block below its top", () => {
    const items = [at("Text above the figure.", 50, 700), at("Figure 1. A caption.", 50, 500)];
    const xhtml = layoutToXhtml({ items, images: [{ id: "abc", top: 690 }], label: null, anchors: [], layout }).xhtml;
    expect(xhtml.indexOf("abc")).toBeGreaterThan(xhtml.indexOf("Text above"));
    expect(xhtml.indexOf("abc")).toBeLessThan(xhtml.indexOf("Figure 1."));
  });

  it("makes the chapters from the headings of a PDF with no bookmarks", () => {
    const heading = (level: number, text: string, id: string) => ({ id, level, text });
    expect(
      tocFromHeadings([
        { page: 1, heading: heading(1, "A Book", "heading-1") },
        { page: 2, heading: heading(2, "Introduction", "heading-1") },
        { page: 2, heading: heading(3, "Details", "heading-2") },
        { page: 5, heading: heading(2, "Methods", "heading-1") },
      ]),
    ).toEqual([
      { title: "Introduction", file: "page-0002", anchor: "heading-1", children: [] },
      { title: "Methods", file: "page-0005", anchor: "heading-1", children: [] },
    ]);
  });
});

describe("chapters of a PDF", () => {
  it("keeps a chapter with sections on later pages as one chapter, and skips the title page and the notices", () => {
    const words = (topic: string) => Array.from({ length: 60 }, (_, i) => `${topic}${i}`).join(" ");
    const pages = [
      '<span id="outline-1"/><h1>A Small Book</h1><p>By an author.</p>',
      '<span id="outline-2"/><h1>Notice of Rights</h1><p>All rights reserved.</p>',
      '<span id="outline-3"/><h1>Chapter 1. Basics</h1><p>A short introduction.</p>',
      `<span id="outline-4"/><h2>First Section</h2><p>${words("first")}</p>`,
      `<span id="outline-5"/><h2>Second Section</h2><p>${words("second")}</p>`,
    ];
    const blocks: Block[] = [];
    pages.forEach((html, i) => {
      const xhtml = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>${html}</body></html>`;
      blocks.push(...flattenXhtml(pageFile(i + 1), xhtml, blocks.length, new Map()));
    });
    const entry = (n: number, title: string, children: BookSource["toc"] = []) => ({ title, file: pageFile(n), anchor: `outline-${n}`, children });
    const source: BookSource = {
      format: "pdf",
      title: "A Small Book",
      authors: [],
      tocSource: "outline",
      toc: [entry(1, "A Small Book"), entry(2, "Notice of Rights"), entry(3, "Chapter 1. Basics", [entry(4, "First Section"), entry(5, "Second Section")])],
      landmarks: [],
      blocks,
      images: new Map(),
      notes: [],
    };
    const book = buildBook(source, { minSectionWords: 20 });
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["Chapter 1. Basics"]);
    expect(book.chapters[0]!.sections.map((section) => section.title)).toEqual(["First Section", "Second Section"]);
    expect(book.skipped.map((part) => part.title)).toEqual(["A Small Book", "Notice of Rights"]);
  });
});

describe("allowsCopy", () => {
  it("allows a PDF with no encryption, and a PDF whose permissions allow the copy", () => {
    expect(allowsCopy(null)).toBe(true);
    expect(allowsCopy(new Set([PermissionFlag.PRINT, PermissionFlag.COPY]))).toBe(true);
    expect(allowsCopy([PermissionFlag.COPY])).toBe(true);
  });

  it("finds a PDF whose permissions do not allow the copy, also with the copy for accessibility", () => {
    expect(allowsCopy(new Set([PermissionFlag.PRINT, PermissionFlag.COPY_FOR_ACCESSIBILITY]))).toBe(false);
    expect(allowsCopy([])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { flattenXhtml } from "../src/ingest/core/blocks.js";
import { splitChapter } from "../src/ingest/core/structure.js";
import { htmlToMarkdown } from "../src/ingest/core/markdown.js";
import { pageToXhtml, type FontStyle, type PdfTextItem, type StructNode } from "../src/ingest/pdf/page.js";
import { joinAcrossPages, joinLabels, styleOfFont } from "../src/ingest/pdf/read.js";

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

function markdownOf(xhtml: string): string {
  return flattenXhtml("page-0001", xhtml, 0, new Map())
    .map((block) => htmlToMarkdown(block.html))
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

import { beforeAll, describe, expect, it } from "vitest";
import { classify } from "../src/ingest/core/structure.js";
import type { ParsedBook, ParsedChapter } from "../src/ingest/core/types.js";
import { parseEpub } from "../src/ingest/parse.js";
import { buildEpub, mainFixture, ncxFixture, styledFixture } from "./fixtures/epub.js";

let book: ParsedBook;
const chapter = (title: string): ParsedChapter => {
  const found = book.chapters.find((item) => item.title === title);
  if (!found) throw new Error(`No chapter "${title}"`);
  return found;
};

beforeAll(async () => {
  book = await parseEpub(await buildEpub(mainFixture()), { maxSectionWords: 120, minSectionWords: 40 });
});

describe("chapters", () => {
  it("finds the chapters in reading order and skips the other parts", () => {
    expect(book.title).toBe("Fixture Book");
    expect(book.authors).toEqual(["Test Author"]);
    expect(book.tocSource).toBe("nav");
    expect(book.chapters.map((item) => item.title)).toEqual(["Getting Started", "Branching", "Remotes", "Tags", "Internals"]);
    expect(book.skipped.map((part) => [part.title, part.kind])).toEqual([
      ["Text before the table of contents", "front"],
      ["Copyright", "front"],
      ["Part I. Basics", "part"],
      ["Glossary", "glossary"],
      ["Index", "index"],
    ]);
  });

  it("gives the chapters of a part the part title", () => {
    expect(chapter("Getting Started").part).toBe("Part I. Basics");
    expect(chapter("Branching").part).toBe("Part I. Basics");
    expect(chapter("Remotes").part).toBeNull();
  });

  it("keeps a chapter that continues in a file outside the table of contents", () => {
    const branching = chapter("Branching");
    expect(branching.files).toEqual(["OEBPS/ch2a.xhtml", "OEBPS/ch2b.xhtml"]);
    expect(branching.sections.map((section) => section.title)).toContain("Merging");
    expect(book.warnings.some((warning) => warning.code === "not_in_toc" && warning.message.includes("ch2b.xhtml"))).toBe(true);
  });

  it("splits two chapters in one file at their anchors", () => {
    const remotes = chapter("Remotes").sections.map((section) => section.markdown).join("\n");
    const tags = chapter("Tags").sections.map((section) => section.markdown).join("\n");
    expect(remotes).toContain("Remote text.");
    expect(remotes).not.toContain("Tag text.");
    expect(tags).toContain("Tag text.");
  });

  it("loses no text", () => {
    expect(book.warnings.filter((warning) => warning.code === "lost_text")).toEqual([]);
    for (const item of book.chapters) expect(item.words).toBeGreaterThanOrEqual(item.sourceWords);
  });
});

describe("sections", () => {
  it("splits a chapter at its highest heading level", () => {
    const sections = chapter("Getting Started").sections;
    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ["1.1", "Getting Started"],
      ["1.2", "First Section"],
      ["1.3", "Second Section"],
      ["1.4", "Summary"],
    ]);
  });

  it("splits a long section at its subheadings, and by size if it has none", () => {
    expect(chapter("Internals").sections.map((section) => section.title)).toEqual([
      "Objects",
      "Blobs",
      "Trees",
      "Packfiles",
      "Packfiles (part 2)",
    ]);
    expect(book.warnings.some((warning) => warning.code === "size_split" && warning.message.includes("Packfiles"))).toBe(true);
  });

  it("gives each section the print page where it starts", () => {
    expect(chapter("Getting Started").sections.map((section) => section.page)).toEqual([null, "5", "5", "6"]);
  });
});

describe("markdown", () => {
  const first = () => chapter("Getting Started").sections[1]!.markdown;

  it("keeps code, callouts, captions, images, tables, and footnotes", () => {
    expect(first()).toContain("```sh\ngit init\ngit status\n```");
    expect(first()).toContain("> **Note: Be careful**");
    expect(first()).toContain("[Image: Diagram of the states]");
    expect(first()).toContain("_Figure 1. The three states_");
    expect(first()).toContain("| init | Creates a repository |");
    expect(first()).toContain("[1]");
    expect(first()).toContain("> **Footnote**");
    expect(first()).toContain("### A Subsection");
  });

  it("keeps the text after a self-closing anchor in its paragraph", () => {
    expect(first()).toContain("The text continues here with more words after the anchor.");
  });

  it("keeps external links and removes internal links", () => {
    const second = chapter("Getting Started").sections[2]!.markdown;
    expect(second).toContain("[link](https://example.com/docs)");
    expect(second).toContain("an internal link.");
  });

  it("decodes HTML entities and removes styles", () => {
    const intro = chapter("Getting Started").sections[0]!.markdown;
    expect(intro).not.toContain("&nbsp;");
    expect(intro).not.toContain("color: red");
  });
});

describe("checklist", () => {
  const items = () => chapter("Getting Started").checklist;
  const find = (term: string) => items().find((item) => item.term.toLowerCase() === term.toLowerCase());

  it("collects marked terms but not common words", () => {
    expect(find("working tree")).toMatchObject({ source: "dfn", sectionId: "1.1" });
    expect(find("staging area")).toMatchObject({ source: "emphasis", sectionId: "1.2" });
    expect(find("only")).toBeUndefined();
  });

  it("collects the items of a summary section", () => {
    expect(items().filter((item) => item.source === "summary").map((item) => item.term)).toEqual([
      "Git records snapshots of files.",
      "The staging area holds the next commit.",
    ]);
  });

  it("puts glossary terms into the chapter that uses them, and keeps the strongest source", () => {
    expect(find("snapshot")).toMatchObject({ source: "glossary", sectionId: "1.2", detail: "A record of the files at one time." });
    expect(book.unassignedTerms.map((item) => item.term)).toEqual(["Rebase"]);
    expect(book.warnings.some((warning) => warning.code === "unassigned_terms")).toBe(true);
  });

  it("follows index links to their sections", () => {
    expect(find("anchor term")).toMatchObject({ source: "index", sectionId: "1.2" });
    expect(chapter("Tags").checklist.find((item) => item.term === "annotated (tags)")).toMatchObject({ sectionId: "4.1" });
  });
});

describe("EPUB 2", () => {
  it("reads an NCX table of contents and an NCX page list", async () => {
    const ncxBook = await parseEpub(await buildEpub(ncxFixture()));
    expect(ncxBook.tocSource).toBe("ncx");
    expect(ncxBook.chapters.map((item) => item.title)).toEqual(["One", "Two"]);
    expect(ncxBook.chapters[0]!.sections.map((section) => [section.title, section.page])).toEqual([
      ["One", null],
      ["Later", null],
      ["End", "7"],
    ]);
  });
});

describe("classify", () => {
  it("does not take a chapter about indexes for the book index", () => {
    expect(classify("Indexes", [])).toBe("chapter");
    expect(classify("Index", [])).toBe("index");
    expect(classify("Preface by the Author", ["chapter"])).toBe("front");
    expect(classify("Appendix A: Commands", [])).toBe("appendix");
  });
});

describe("books that use CSS classes", () => {
  let styled: ParsedBook;
  beforeAll(async () => {
    styled = await parseEpub(await buildEpub(styledFixture()), { maxSectionWords: 250, minSectionWords: 20 });
  });

  it("reads a paragraph with a large font as a heading", () => {
    const sections = styled.chapters[0]!.sections;
    expect(sections.map((section) => section.title)).toEqual(["Practice No. 1", "First Pose (Asana)", "Second Pose"]);
    expect(sections[1]!.markdown).toMatch(/^#+ First Pose \(_Asana_\)/);
  });

  it("reads bold and italic classes", () => {
    const markdown = styled.chapters[0]!.sections[1]!.markdown;
    expect(markdown).toContain("**Lie on your back.**");
    expect(markdown).toContain("_drishti_");
  });

  it("splits a large container without headings by size", () => {
    expect(styled.chapters[1]!.sections.length).toBeGreaterThan(1);
  });

  it("reads glossary entries with bold classes", () => {
    expect(styled.glossaryEntries).toBe(2);
    expect(styled.chapters[0]!.checklist.find((item) => item.term === "Drishti")).toMatchObject({ source: "glossary" });
  });

  it("skips a bibliography and keeps an unlisted file after the index separate", () => {
    expect(styled.chapters.map((item) => item.title)).toEqual(["Practice No. 1", "Essay"]);
    expect(styled.skipped.map((part) => [part.title, part.kind])).toEqual([
      ["For the Curious (Bibliography)", "back"],
      ["Glossary", "glossary"],
      ["Index", "index"],
      ["ads.xhtml", "back"],
    ]);
  });
});

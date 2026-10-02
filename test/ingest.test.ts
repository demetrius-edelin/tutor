import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import type { ParsedBook } from "../src/ingest/core/types.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { emptyMap, type ConceptMap, type MapSource } from "../src/ingest/map.js";
import { parseEpub } from "../src/ingest/parse.js";
import { digestChapter } from "../src/ingest/stages/digest.js";
import { extractGroup, groupSections } from "../src/ingest/stages/extract.js";
import { mergeChapter } from "../src/ingest/stages/merge.js";
import type { ChapterInput, FoundConcept } from "../src/ingest/stages/types.js";
import { buildEpub, mainFixture } from "./fixtures/epub.js";
import { defaultConcept, FakeLlm } from "./fakes/llm.js";

const section = (id: string, text: string, words = text.split(" ").length) => ({ id, title: `Title ${id}`, markdown: text, words });
const chapter: ChapterInput = {
  number: 1,
  title: "Indexes",
  sections: [
    section("1.1", "An index makes the lookup of rows faster than a full table scan."),
    section("1.2", "A B-tree index keeps the keys in sorted order for range queries."),
    section("1.3", "In this chapter you learned about indexes."),
  ],
};

describe("groupSections", () => {
  it("limits the number of sections and the size of a group", () => {
    const sections = Array.from({ length: 10 }, (_, i) => section(`1.${i + 1}`, "x", 5000));
    expect(groupSections(sections, 8, 24000).map((group) => group.length)).toEqual([3, 3, 3, 1]);
    expect(groupSections(sections.map((item) => ({ ...item, words: 10 })), 4).map((group) => group.length)).toEqual([4, 4, 2]);
  });
});

describe("extractGroup", () => {
  it("asks again for sections without an entry and for quotes that are not in the text", async () => {
    const llm = new FakeLlm({
      extract: (sources, call) =>
        call === 1
          ? {
              sections: [
                { sectionId: "1.1", concepts: [{ ...defaultConcept(sources[0]!), quote: "words that are not there" }], noConceptReason: null },
                { sectionId: "1.3", concepts: [], noConceptReason: "summary" },
              ],
            }
          : { sections: sources.map((source) => ({ sectionId: source.id, concepts: [defaultConcept(source)], noConceptReason: null })) },
    });
    const entries = await extractGroup(llm, "Book", chapter, chapter.sections);
    expect(llm.count("extract")).toBe(2);
    expect(llm.calls[1]!.request.sources!.map((source) => source.id)).toEqual(["1.1", "1.2"]);
    expect(entries.get("1.1")!.concepts[0]!.quote).toBe("An index makes the lookup");
    expect(entries.get("1.2")!.concepts).toHaveLength(1);
    expect(entries.get("1.3")).toEqual({ concepts: [], reason: "summary" });
  });
});

describe("digestChapter", () => {
  it("joins a concept from two sections, adds review concepts, and records minor items and empty sections", async () => {
    const llm = new FakeLlm({
      extract: (sources) => ({
        sections: sources.map((source) =>
          source.id === "1.3"
            ? { sectionId: source.id, concepts: [], noConceptReason: "summary" }
            : { sectionId: source.id, concepts: [{ ...defaultConcept(source), name: "Indexes" }], noConceptReason: null },
        ),
      }),
      review: () => ({
        items: [{ term: "full table scan", decision: "minor", concept: null, reason: "an example" }],
        newConcepts: [{ ...defaultConcept({ id: "1.2", title: "x > Range queries", text: "range queries" }), quote: "sorted order for range queries", sectionId: "1.2" }],
      }),
    });
    const checklist = [{ term: "full table scan", source: "bold" as const, sectionId: "1.1" }];
    const digest = await digestChapter(llm, "Book", chapter, checklist);
    expect(digest.concepts.map((concept) => [concept.name, concept.sources.map((source) => source.sectionId)])).toEqual([
      ["Indexes", ["1.1", "1.2"]],
      ["Range queries", ["1.2"]],
    ]);
    expect(digest.concepts[1]!.origin).toBe("review");
    expect(digest.emptySections).toEqual([{ sectionId: "1.3", reason: "summary" }]);
    expect(digest.minorItems).toEqual([{ term: "full table scan", source: "bold", reason: "an example" }]);
    expect(digest.quoteWarnings).toEqual([]);
    expect(llm.calls.find((call) => call.stage === "review")!.request.prompt).toContain("- full table scan [bold, section 1.1]");
  });
});

describe("mergeChapter", () => {
  const found = (name: string): FoundConcept => ({
    name,
    objective: `Explain ${name}.`,
    kind: "knowledge",
    level: "basic",
    sources: [{ sectionId: "2.1", quote: "q", quoteFound: true }],
    origin: "extract",
  });
  const toSource = (source: { sectionId: string; quote: string; quoteFound: boolean }): MapSource => ({
    key: `book#${source.sectionId}`,
    display: source.sectionId,
    quote: source.quote,
    quoteFound: source.quoteFound,
  });

  it("joins the same idea, adds new concepts to modules, and sets prerequisites", async () => {
    const map: ConceptMap = emptyMap();
    map.modules.push({ name: "Indexes", position: 1, rowId: null });
    map.concepts.push({ slug: "b-tree-index", name: "B-tree index", objective: "o", kind: "knowledge", level: "basic", module: "Indexes", sources: [], prerequisites: [], rowId: null });
    const llm = new FakeLlm({
      merge: () => ({
        newModules: ["Query plans"],
        concepts: [
          { id: "n1", action: "join", joinWith: "b-tree-index", module: "Indexes", level: "basic", prerequisites: [] },
          { id: "n2", action: "add", joinWith: null, module: "Query plans", level: "intermediate", prerequisites: ["b-tree-index", "n3", "unknown", "n2"] },
          { id: "n3", action: "add", joinWith: null, module: "query PLANS", level: "basic", prerequisites: ["n2"] },
        ],
      }),
    });
    const stats = await mergeChapter(llm, map, "Chapter 2", [found("B-trees"), found("Index scan"), found("Table scan")], toSource);
    expect(stats).toEqual({ added: 2, joined: 1 });
    expect(map.concepts[0]!.sources.map((source) => source.key)).toEqual(["book#2.1"]);
    expect(map.modules.map((module) => module.name)).toEqual(["Indexes", "Query plans"]);
    const indexScan = map.concepts.find((concept) => concept.name === "Index scan")!;
    expect(indexScan).toMatchObject({ slug: "index-scan", module: "Query plans", level: "intermediate", prerequisites: ["b-tree-index", "table-scan"] });
    // No direct cycle: the table scan cannot need the index scan, because the index scan needs it.
    expect(map.concepts.find((concept) => concept.name === "Table scan")!.prerequisites).toEqual([]);
  });

  it("joins a concept with the same name without a model request", async () => {
    const map = emptyMap();
    map.modules.push({ name: "Indexes", position: 1, rowId: 7 });
    map.concepts.push({ slug: "b-tree-index", name: "B-tree Index", objective: "o", kind: "knowledge", level: "basic", module: "Indexes", sources: [], prerequisites: [], rowId: 7 });
    const llm = new FakeLlm();
    expect(await mergeChapter(llm, map, "Chapter 2", [found("b-tree index")], toSource)).toEqual({ added: 0, joined: 1 });
    expect(llm.count("merge")).toBe(0);
    expect(map.concepts[0]!.sources.map((source) => source.key)).toEqual(["book#2.1"]);
  });

  it("puts a concept without a decision into a module with the chapter name", async () => {
    const map = emptyMap();
    const llm = new FakeLlm({ merge: () => ({ newModules: [], concepts: [] }) });
    await mergeChapter(llm, map, "Transactions", [found("ACID")], toSource);
    expect(map.concepts[0]!.module).toBe("Transactions");
  });
});

describe("ingestBook", () => {
  let book: ParsedBook;
  let dataDir: string;
  let bookFile: string;
  let db: Db;

  beforeAll(async () => {
    const data = await buildEpub(mainFixture());
    book = await parseEpub(data);
    dataDir = mkdtempSync(join(tmpdir(), "tutor-ingest-"));
    bookFile = join(dataDir, "fixture.epub");
    writeFileSync(bookFile, data);
    db = openDb(":memory:");
  });

  it("previews some chapters and does not change the database", async () => {
    const llm = new FakeLlm();
    const report = await ingestBook({ llm, db, dataDir, themeName: "Git", bookFile, book, chapters: [1] });
    expect(report.preview).toBe(true);
    expect(report.chapters.map((chapter) => chapter.number)).toEqual([1]);
    expect(db.prepare("SELECT COUNT(*) FROM concepts").pluck().get()).toBe(0);
    expect(readFileSync(report.conceptMapFile, "utf8")).toContain("# Concept map: Git (preview of Fixture Book)");
  });

  it("saves the book, the sections, and the concept map", async () => {
    const llm = new FakeLlm();
    const report = await ingestBook({ llm, db, dataDir, themeName: "Git", bookFile, book });
    const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    const sections = book.chapters.reduce((total, chapter) => total + chapter.sections.length, 0);
    expect(count("themes")).toBe(1);
    expect(db.prepare("SELECT status FROM books").pluck().get()).toBe("ready");
    expect(count("sections")).toBe(sections);
    expect(count("concepts")).toBe(report.concepts);
    expect(count("concept_sources")).toBe(sections);
    expect(count("concept_prereqs")).toBeGreaterThan(0);
    expect(report.concepts).toBe(sections);
    expect(existsSync(join(dataDir, "themes", "git", "concept-map.md"))).toBe(true);
    expect(existsSync(join(dataDir, "themes", "git", "books", "fixture-book", "fixture.epub"))).toBe(true);
    // Chapter 1 came from the cache of the preview: only the other chapters needed extract requests.
    expect(llm.calls.some((call) => call.request.sources?.some((source) => source.id.startsWith("1.")))).toBe(false);
  });

  it("saves some chapters with save, and keeps their concepts in a later full run", async () => {
    const otherDb = openDb(":memory:");
    await ingestBook({ llm: new FakeLlm(), db: otherDb, dataDir, themeName: "Partial", bookFile, book, chapters: [1], save: true });
    const firstIds = otherDb.prepare("SELECT id FROM concepts ORDER BY id").pluck().all();
    expect(firstIds.length).toBe(book.chapters[0]!.sections.length);
    expect(otherDb.prepare("SELECT COUNT(*) FROM sections").pluck().get()).toBe(
      book.chapters.reduce((total, chapter) => total + chapter.sections.length, 0),
    );

    await ingestBook({ llm: new FakeLlm(), db: otherDb, dataDir, themeName: "Partial", bookFile, book, replace: true });
    const ids = otherDb.prepare("SELECT id FROM concepts ORDER BY id").pluck().all();
    expect(ids.slice(0, firstIds.length)).toEqual(firstIds);
    expect(ids.length).toBeGreaterThan(firstIds.length);
  });

  it("needs --replace for a book that the theme has already", async () => {
    await expect(ingestBook({ llm: new FakeLlm(), db, dataDir, themeName: "Git", bookFile, book })).rejects.toThrow(/--replace/);
  });

  it("replaces a book with the cached chapter results, and keeps the concepts that it finds again", async () => {
    const before = db.prepare("SELECT id, slug FROM concepts ORDER BY id").all() as { id: number; slug: string }[];
    const llm = new FakeLlm({
      merge: (ids, prompt) => ({
        newModules: [],
        concepts: ids.map((id) => {
          const name = new RegExp(`^${id}: (.+?): `, "m").exec(prompt)![1]!;
          const match = before.find((concept) => concept.slug === name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
          return { id, action: match ? "join" : "add", joinWith: match?.slug ?? null, module: "Basics", level: "basic", prerequisites: [] };
        }),
      }),
    });
    await ingestBook({ llm, db, dataDir, themeName: "Git", bookFile, book, replace: true });
    expect(llm.count("extract")).toBe(0);
    expect(llm.count("review")).toBe(0);
    const after = db.prepare("SELECT id, slug FROM concepts ORDER BY id").all();
    expect(after).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) FROM books").pluck().get()).toBe(1);
  });
});

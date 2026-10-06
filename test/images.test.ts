import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { buildBook } from "../src/ingest/core/book.js";
import { encodePng, imageId, shrink } from "../src/ingest/core/png.js";
import type { BookSource } from "../src/ingest/core/source.js";
import type { ParsedBook } from "../src/ingest/core/types.js";
import { imageIds, imageMarkdown, imagesToRead, readImages } from "../src/ingest/images.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { parseEpub, readBookSource } from "../src/ingest/parse.js";
import { refreshBook } from "../src/ingest/refresh.js";
import { buildEpub, words, xhtml, type FixtureBook } from "./fixtures/epub.js";
import { FakeLlm } from "./fakes/llm.js";

const square = (value: number) => encodePng({ width: 2, height: 2, channels: 3, data: new Uint8Array(12).fill(value) });

// A chapter with a code image in a figure, a small image in a table cell, a missing image, and an SVG image.
function imageFixture(): FixtureBook {
  return {
    title: "Image Book",
    files: {
      "ch1.xhtml": xhtml(`<section epub:type="chapter"><h1>Queries</h1>
<section><h2>First Query</h2><p>${words(50, "query")}</p>
<figure><img src="images/q1.png" alt="A black screen with white text"/></figure>
<p>The query above finds the rows.</p></section>
<section><h2>Results</h2><p>${words(50, "result")}</p>
<table><tr><th>Result</th></tr><tr><td><img src="images/q2.png" alt="Small result"/></td></tr></table>
<p><img src="images/missing.png" alt="Missing picture"/> <img src="images/d.svg" alt="Vector diagram"/></p></section>
</section>`),
      "images/q1.png": square(200),
      "images/q2.png": square(100),
    },
    spine: ["ch1.xhtml"],
    nav: xhtml(`<nav epub:type="toc"><ol><li><a href="ch1.xhtml">Queries</a></li></ol></nav>`),
  };
}

const CODE = "_The tutor read this code from an image:_\n\n```sql\nSELECT 1;\n```";
const sectionOf = (book: ParsedBook, title: string) => book.chapters.flatMap((chapter) => chapter.sections).find((section) => section.title === title)!;

describe("encodePng", () => {
  it("writes a PNG file that a decoder can read back", () => {
    const pixels = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const png = encodePng({ width: 2, height: 2, channels: 3, data: pixels });
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([2, 2, 8, 2]);

    // Undo the "Up" filter of each row.
    const length = view.getUint32(33);
    const raw = inflateSync(png.slice(41, 41 + length));
    const rows = [raw.subarray(1, 7), raw.subarray(8, 14)];
    expect([raw[0], raw[7]]).toEqual([2, 2]);
    const second = rows[1]!.map((value, i) => (value + rows[0]![i]!) & 0xff);
    expect([...rows[0]!, ...second]).toEqual([...pixels]);
  });

  it("makes a large image smaller, with the average of the covered pixels", () => {
    const pixels = { width: 4, height: 2, channels: 1 as const, data: Uint8Array.from([0, 100, 200, 200, 0, 100, 0, 0]) };
    expect(shrink(pixels, 2)).toEqual({ width: 2, height: 1, channels: 1, data: Uint8Array.from([50, 100]) });
    expect(shrink(pixels, 4)).toBe(pixels);
  });

  it("gives the same id to the same image", () => {
    expect(imageId(square(1))).toBe(imageId(square(1)));
    expect(imageId(square(1))).not.toBe(imageId(square(2)));
  });
});

describe("images in the parse", () => {
  let source: BookSource;
  beforeEach(async () => {
    source = await readBookSource(await buildEpub(imageFixture()), "book.epub");
  });

  it("keeps the images that the model can read, and warns about the images without text", () => {
    const book = buildBook(source);
    const first = sectionOf(book, "First Query");
    const results = sectionOf(book, "Results");
    expect(first.images).toEqual([imageId(square(200))]);
    expect(results.images).toEqual([imageId(square(100))]);
    expect([...book.images.keys()]).toEqual([imageId(square(200)), imageId(square(100))]);
    expect(book.images.get(imageId(square(200)))).toEqual({ mediaType: "image/png", data: square(200) });
    expect(first.markdown).toContain("[Image: A black screen with white text]");
    expect(results.markdown).toContain("[Image: Missing picture] [Image: Vector diagram]");
    expect(book.warnings).toContainEqual(expect.objectContaining({ code: "unread_images", message: expect.stringMatching(/^2 images/) }));
  });

  it("puts the text of an image in the place of the image", () => {
    const table = "_The tutor read this table from an image:_\n\n| a |\n| --- |\n| 1 |";
    const imageText = new Map([
      [imageId(square(200)), CODE],
      [imageId(square(100)), table],
    ]);
    const book = buildBook(source, { imageText });
    const first = sectionOf(book, "First Query");
    expect(first.markdown).toContain(`${"query ".repeat(49)}query\n\n${CODE}\n\nThe query above finds the rows.`);
    expect(first.words).toBeGreaterThan(sectionOf(buildBook(source), "First Query").words);
    // A block of text cannot go into a table cell, so the cell keeps the placeholder.
    expect(sectionOf(book, "Results").markdown).toContain("| [Image: Small result] |");
    expect(book.warnings.map((warning) => warning.code)).not.toContain("unread_images");
  });

  it("puts a one-line description into the text, also in a table cell", () => {
    const book = buildBook(source, { imageText: new Map([[imageId(square(100)), "[Image: A table with one value]"]]) });
    expect(sectionOf(book, "Results").markdown).toContain("| [Image: A table with one value] |");
  });
});

describe("imageMarkdown", () => {
  it("writes code as a fenced block, a table as Markdown, and other images as a description", () => {
    expect(imageMarkdown({ kind: "code", language: "SQL", text: "SELECT 1;\n" })).toBe(CODE);
    expect(imageMarkdown({ kind: "code", language: "not a name", text: "  x = 1" })).toBe(
      "_The tutor read this code from an image:_\n\n```\n  x = 1\n```",
    );
    expect(imageMarkdown({ kind: "code", language: "", text: "```\ncode\n```" })).toContain("~~~~\n```\ncode\n```\n~~~~");
    expect(imageMarkdown({ kind: "table", language: "", text: "| a |\n| --- |" })).toBe("_The tutor read this table from an image:_\n\n| a |\n| --- |");
    expect(imageMarkdown({ kind: "other", language: "", text: "A diagram\nof three states." })).toBe("[Image: A diagram of three states.]");
    expect(imageMarkdown({ kind: "other", language: "", text: " " })).toBeNull();
  });
});

// A book with the given number of images, one image in each section.
function bookWithImages(count: number): ParsedBook {
  const ids = Array.from({ length: count }, (_, i) => imageId(square(i)));
  return {
    chapters: [{ number: 1, sections: ids.map((id) => ({ images: [id] })) }],
    images: new Map(ids.map((id, i) => [id, { mediaType: "image/png", data: square(i) }])),
  } as unknown as ParsedBook;
}

describe("readImages", () => {
  let cacheFile: string;
  beforeEach(() => {
    cacheFile = join(mkdtempSync(join(tmpdir(), "tutor-images-")), "work", "images.json");
  });

  it("reads each image one time and keeps the results in the cache", async () => {
    const book = bookWithImages(2);
    const llm = new FakeLlm();
    const report = await readImages(llm, book, cacheFile);
    expect(report).toMatchObject({ total: 2, cached: 0, read: 2, warning: null });
    expect([...report.text.values()]).toEqual([CODE, CODE]);
    expect(llm.calls[0]!.request.images).toEqual([book.images.get(imageIds(book)[0]!)]);
    expect(imagesToRead(book, cacheFile)).toEqual([]);

    const again = new FakeLlm();
    expect(await readImages(again, book, cacheFile)).toMatchObject({ total: 2, cached: 2, read: 0 });
    expect(again.count("image")).toBe(0);
  });

  it("reads only the images of the selected chapters", async () => {
    const llm = new FakeLlm();
    expect(await readImages(llm, bookWithImages(2), cacheFile, { chapters: [2] })).toMatchObject({ total: 0, read: 0 });
    expect(llm.count("image")).toBe(0);
  });

  it("stops after failures in a row, and keeps the results before them", async () => {
    const book = bookWithImages(9);
    const llm = new FakeLlm({
      image: (_images, call) => {
        if (call > 2) throw new Error("The model does not accept images.");
        return { kind: "other", language: "", text: "A photo." };
      },
    });
    const report = await readImages(llm, book, cacheFile);
    expect(report.read).toBe(2);
    expect(llm.count("image")).toBeLessThan(9);
    expect(report.warning).toBe(
      "The model did not read 7 images. The first error: The model does not accept images. To try again, run the command again. " +
        "The sections keep the alternative text of these images.",
    );
    expect(imagesToRead(book, cacheFile)).toHaveLength(7);
  });
});

describe("refreshBook", () => {
  let db: Db;
  let dataDir: string;
  const fileOf = (title: string) => {
    const path = db.prepare("SELECT path FROM sections WHERE title = ?").pluck().get(title) as string;
    return readFileSync(join(dataDir, path), "utf8");
  };
  const sectionRows = () => db.prepare("SELECT id, chapter, number, path, words FROM sections ORDER BY id").all() as { id: number; words: number }[];

  beforeEach(async () => {
    const data = await buildEpub(imageFixture());
    dataDir = mkdtempSync(join(tmpdir(), "tutor-refresh-"));
    const bookFile = join(dataDir, "image-book.epub");
    writeFileSync(bookFile, data);
    db = openDb(":memory:");
    await ingestBook({ llm: new FakeLlm(), db, dataDir, subjectName: "SQL", bookFile, book: await parseEpub(data) });
    // Progress: a lesson about the concept of the first section.
    const conceptId = db.prepare("SELECT id FROM concepts WHERE name = 'First Query'").pluck().get();
    db.prepare("INSERT INTO lessons (concept_id, round, text) VALUES (?, 1, 'An old lesson.')").run(conceptId);
  });

  it("writes the image text into the section files, and keeps the sections, the concepts, and the lessons", async () => {
    const before = sectionRows();
    const concepts = db.prepare("SELECT id, name, status FROM concepts ORDER BY id").all();
    expect(fileOf("First Query")).toContain("[Image: A black screen with white text]");

    const llm = new FakeLlm();
    const report = (await refreshBook({ llm, db, dataDir, subjectName: "SQL", bookName: "Image Book" }))!;
    expect(report.chapters).toEqual([1]);
    expect(report.images).toMatchObject({ total: 2, read: 2, warning: null });
    // The code of the second image cannot go into its table cell, so only the first section changes.
    expect(report.changedSections).toEqual([sectionOf(await parseEpub(await buildEpub(imageFixture())), "First Query").id]);
    expect(report.oldLessons).toEqual(["First Query"]);
    expect(fileOf("First Query")).toContain(CODE);

    const after = sectionRows();
    expect(after.map(({ words: _words, ...row }) => row)).toEqual(before.map(({ words: _words, ...row }) => row));
    expect(after.find((row) => row.id === before[0]!.id)!.words).toBeGreaterThan(before[0]!.words);
    expect(db.prepare("SELECT id, name, status FROM concepts ORDER BY id").all()).toEqual(concepts);
    expect(db.prepare("SELECT text FROM lessons").pluck().all()).toEqual(["An old lesson."]);

    // A second run reads no image and changes no section.
    const again = new FakeLlm();
    const second = (await refreshBook({ llm: again, db, dataDir, subjectName: "sql", bookName: "image-book" }))!;
    expect(again.count("image")).toBe(0);
    expect(second.changedSections).toEqual([]);
  });

  it("reads only the images of the chapters with concepts", async () => {
    db.prepare("DELETE FROM concept_sources").run();
    const llm = new FakeLlm();
    const report = (await refreshBook({ llm, db, dataDir, subjectName: "SQL", bookName: "Image Book" }))!;
    expect(report.chapters).toEqual([]);
    expect(report.images).toMatchObject({ total: 0, read: 0 });
    expect(llm.count("image")).toBe(0);
    expect(fileOf("First Query")).toContain("[Image: A black screen with white text]");
  });

  it("asks before the model reads the images, and stops on no", async () => {
    const llm = new FakeLlm();
    const asked: number[] = [];
    const report = await refreshBook({
      llm,
      db,
      dataDir,
      subjectName: "SQL",
      bookName: "Image Book",
      confirm: async (images) => {
        asked.push(images);
        return false;
      },
    });
    expect(report).toBeNull();
    expect(asked).toEqual([2]);
    expect(llm.count("image")).toBe(0);
    expect(fileOf("First Query")).not.toContain(CODE);
  });

  it("changes nothing if a section does not match its row in the database", async () => {
    const first = sectionRows()[0]!.id;
    db.prepare("UPDATE sections SET path = 'subjects/sql/books/image-book/sections/other.md' WHERE id = ?").run(first);
    const before = sectionRows();
    const files = before.map((row) => existsSync(join(dataDir, (row as unknown as { path: string }).path)));
    await expect(refreshBook({ llm: new FakeLlm(), db, dataDir, subjectName: "SQL", bookName: "Image Book" })).rejects.toThrow(
      /does not match the database, so the command did not change the sections\.\n- Section 1\.\d has the file/,
    );
    expect(sectionRows()).toEqual(before);
    expect(before.map((row) => existsSync(join(dataDir, (row as unknown as { path: string }).path)))).toEqual(files);
    expect(fileOf("Results")).not.toContain("tutor read");
  });

  it("names the books of the subject if the book is not there", async () => {
    await expect(refreshBook({ llm: new FakeLlm(), db, dataDir, subjectName: "SQL", bookName: "Other" })).rejects.toThrow(
      'The subject "SQL" has no book "Other". Its books: image-book.',
    );
    await expect(refreshBook({ llm: new FakeLlm(), db, dataDir, subjectName: "Git", bookName: "Other" })).rejects.toThrow(
      'The subject "Git" does not exist.',
    );
  });
});

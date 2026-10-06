import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { parseEpub } from "../src/ingest/parse.js";
import type { ConceptMapView, SectionView, SubjectDetail, SubjectSummary } from "../src/server/api-types.js";
import { buildServer } from "../src/server/app.js";
import { buildEpub, mainFixture } from "./fixtures/epub.js";
import { FakeLlm } from "./fakes/llm.js";

let app: FastifyInstance;

beforeAll(async () => {
  const data = await buildEpub(mainFixture());
  const book = await parseEpub(data);
  const dataDir = mkdtempSync(join(tmpdir(), "tutor-server-"));
  const bookFile = join(dataDir, "fixture.epub");
  writeFileSync(bookFile, data);
  const db = openDb(":memory:");
  await ingestBook({ llm: new FakeLlm(), db, dataDir, subjectName: "Git", bookFile, book });
  app = buildServer({ db, dataDir });
});

afterAll(async () => {
  await app.close();
});

const get = async <T>(url: string) => {
  const response = await app.inject({ method: "GET", url });
  return { status: response.statusCode, body: response.json() as T };
};

describe("API", () => {
  it("lists the subjects with their progress", async () => {
    const { status, body } = await get<SubjectSummary[]>("/api/subjects");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ slug: "git", name: "Git", books: 1, modules: 1 });
    expect(body[0]!.progress.new).toBe(body[0]!.concepts);
  });

  it("gives the books of a subject", async () => {
    const { body } = await get<SubjectDetail>("/api/subjects/git");
    expect(body.bookList).toEqual([
      expect.objectContaining({ slug: "fixture-book", title: "Fixture Book", format: "epub", chapters: 5, concepts: body.concepts }),
    ]);
  });

  it("gives the status of each module", async () => {
    const { body } = await get<SubjectDetail>("/api/subjects/git");
    expect(body.moduleList).toEqual([expect.objectContaining({ position: 1, name: "Basics", concepts: body.concepts })]);
    expect(body.moduleList[0]!.progress.new).toBe(body.concepts);
    expect(body.nextToLearn).toBeNull();
  });

  it("gives the concept map with prerequisites and sources", async () => {
    const { body } = await get<ConceptMapView>("/api/subjects/git/map");
    const concepts = body.modules.flatMap((module) => module.concepts);
    expect(body.modules[0]!.name).toBe("Basics");
    expect(concepts.length).toBeGreaterThan(5);
    const withPrerequisite = concepts.find((concept) => concept.prerequisites.length > 0)!;
    expect(withPrerequisite.prerequisites[0]).toEqual({ slug: concepts[0]!.slug, name: concepts[0]!.name });
    expect(concepts[1]!.sources[0]).toMatchObject({ ref: "1.2", book: "Fixture Book", title: "First Section", page: "5" });
  });

  it("gives the Markdown text of a section", async () => {
    const map = (await get<ConceptMapView>("/api/subjects/git/map")).body;
    const sectionId = map.modules[0]!.concepts[1]!.sources[0]!.sectionId;
    const { status, body } = await get<SectionView>(`/api/sections/${sectionId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ref: "1.2", title: "First Section", chapterTitle: "Getting Started" });
    expect(body.markdown).toContain("## First Section");
  });

  it("answers 404 for a subject or a section that does not exist", async () => {
    expect((await get("/api/subjects/none")).status).toBe(404);
    expect((await get("/api/subjects/none/map")).status).toBe(404);
    expect((await get("/api/sections/9999")).status).toBe(404);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { parseEpub } from "../src/ingest/parse.js";
import type { LessonView, SessionView } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { buildEpub, mainFixture } from "./fixtures/epub.js";
import { FakeLlm } from "./fakes/llm.js";

let db: Db;
let dataDir: string;
let app: TutorServer;
let llm: FakeLlm;
let conceptIds: number[];

beforeEach(async () => {
  const data = await buildEpub(mainFixture());
  const book = await parseEpub(data);
  dataDir = mkdtempSync(join(tmpdir(), "tutor-lesson-"));
  const bookFile = join(dataDir, "fixture.epub");
  writeFileSync(bookFile, data);
  db = openDb(":memory:");
  await ingestBook({ llm: new FakeLlm(), db, dataDir, themeName: "Git", bookFile, book });
  llm = new FakeLlm();
  app = buildServer({ db, dataDir, llm });
  conceptIds = db.prepare("SELECT id FROM concepts ORDER BY id").pluck().all() as number[];
});

const post = async <T>(url: string, body: unknown = {}) => {
  const response = await app.inject({ method: "POST", url, payload: body as object });
  return { status: response.statusCode, body: response.json() as T };
};
const get = async <T>(url: string) => (await app.inject({ method: "GET", url })).json() as T;
const statusOf = (id: number) => db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(id);

describe("lessons", () => {
  it("writes a short lesson without references, and marks the concept as learning", async () => {
    const id = conceptIds[1]!;
    expect((await get<LessonView>(`/api/concepts/${id}/lesson`)).lesson).toBeNull();

    const { body } = await post<LessonView>(`/api/concepts/${id}/lesson`);
    expect(body.lesson).toMatchObject({ round: 1, text: "The concept, in short.", references: [], detail: null });
    expect(body.concept.status).toBe("learning");
    expect(statusOf(id)).toBe("learning");
    expect(body.queuePosition).toBe(1);
    expect(llm.calls[0]!.textRequest!.cite).toBe(false);
    expect(llm.calls[0]!.textRequest!.sources[0]!.text).toContain("## First Section");
  });

  it("writes the detailed lesson with references on request, one time", async () => {
    const id = conceptIds[1]!;
    const lesson = (await post<LessonView>(`/api/concepts/${id}/lesson`)).body.lesson!;
    const { body } = await post<LessonView>(`/api/lessons/${lesson.id}/detail`);
    expect(body.lesson).toMatchObject({ id: lesson.id, text: "The concept, in short." });
    expect(body.lesson!.detail).toEqual({
      text: "## Explanation\n\nThe concept, from the book [1].",
      references: [expect.objectContaining({ number: 1, ref: "1.2", title: "First Section", book: "Fixture Book", page: "5" })],
    });
    const request = llm.calls.find((call) => call.stage === "detail")!.textRequest!;
    expect(request.cite).toBeUndefined();
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(request.messages[1]!.content).toBe("The concept, in short.");

    await post(`/api/lessons/${lesson.id}/detail`);
    expect(llm.count("detail")).toBe(1);
    expect((await post(`/api/lessons/999/detail`)).status).toBe(404);
  });

  it("uses an existing lesson again, and writes a new round on request", async () => {
    const id = conceptIds[1]!;
    await post(`/api/concepts/${id}/lesson`);
    await post(`/api/concepts/${id}/lesson`);
    expect(llm.count("lesson")).toBe(1);
    const again = (await post<LessonView>(`/api/concepts/${id}/lesson`, { again: true })).body;
    expect(again.lesson!.round).toBe(2);
    expect(llm.calls.at(-1)!.textRequest!.messages[0]!.content).toContain("Teach it again from a different angle");
  });

  it("keeps one learning concept for each theme", async () => {
    await post(`/api/concepts/${conceptIds[1]}/lesson`);
    await post(`/api/concepts/${conceptIds[2]}/lesson`);
    expect(statusOf(conceptIds[1]!)).toBe("queued");
    expect(statusOf(conceptIds[2]!)).toBe("learning");
  });

  it("tells the model about the wrong answers of the diagnosis", async () => {
    const id = conceptIds[0]!;
    const moduleId = db.prepare("SELECT module_id FROM concepts WHERE id = ?").pluck().get(id);
    const { body } = await post<{ sessionId: number }>(`/api/modules/${moduleId}/selection`, { marks: { [id]: "test" } });
    await app.idle();
    const session = await get<SessionView>(`/api/sessions/${body.sessionId}`);
    await post(`/api/questions/${session.questions[1]!.id}/answer`, { answer: "No idea." });

    await post(`/api/concepts/${id}/lesson`);
    const request = llm.calls.find((call) => call.stage === "lesson")!.textRequest!.messages[0]!.content;
    expect(request).toContain("The learner answered these questions wrong");
    expect(request).toContain("Answer of the learner: No idea.");
  });

  it("answers questions about the lesson with the lesson in the conversation", async () => {
    const id = conceptIds[1]!;
    const lesson = (await post<LessonView>(`/api/concepts/${id}/lesson`)).body.lesson!;
    await post(`/api/lessons/${lesson.id}/messages`, { text: "Why is that?" });
    const { body } = await post<LessonView>(`/api/lessons/${lesson.id}/messages`, { text: "And then?" });
    expect(body.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Why is that?"],
      ["assistant", "The answer to your question [1]."],
      ["user", "And then?"],
      ["assistant", "The answer to your question [1]."],
    ]);
    expect(body.messages[1]!.references[0]).toMatchObject({ number: 1, ref: "1.2" });
    const messages = llm.calls.at(-1)!.textRequest!.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[1]!.content).toBe(lesson.text);
    expect((await post(`/api/lessons/${lesson.id}/messages`, { text: " " })).status).toBe(400);

    // The detailed lesson replaces the short lesson in the conversation.
    const detail = (await post<LessonView>(`/api/lessons/${lesson.id}/detail`)).body.lesson!.detail!;
    await post(`/api/lessons/${lesson.id}/messages`, { text: "One more?" });
    expect(llm.calls.at(-1)!.textRequest!.messages[1]!.content).toBe(detail.text);
  });

  it("shows missing prerequisites, and can put a prerequisite at the top or test it", async () => {
    const [prerequisite, concept] = [conceptIds[0]!, conceptIds[1]!];
    db.prepare("DELETE FROM concept_prereqs").run();
    db.prepare("INSERT INTO concept_prereqs (concept_id, prereq_id) VALUES (?, ?)").run(concept, prerequisite);
    await post(`/api/modules/${db.prepare("SELECT module_id FROM concepts WHERE id = ?").pluck().get(concept)}/selection`, {
      marks: { [concept]: "learn" },
    });
    const view = await get<LessonView>(`/api/concepts/${concept}/lesson`);
    expect(view.missingPrerequisites).toEqual([expect.objectContaining({ conceptId: prerequisite, status: "new", position: null })]);
    expect(view.warning).toContain("which you do not know yet");

    await post(`/api/concepts/${prerequisite}/top`);
    const order = db.prepare("SELECT id FROM concepts WHERE queue_pos IS NOT NULL ORDER BY queue_pos").pluck().all();
    expect(order).toEqual([prerequisite, concept]);

    const { body } = await post<{ sessionId: number }>(`/api/concepts/${concept}/test`);
    await app.idle();
    expect((await get<SessionView>(`/api/sessions/${body.sessionId}`)).questions.length).toBe(2);
  });

  it("does not save an empty lesson or an empty answer", async () => {
    await post(`/api/concepts/${conceptIds[1]}/lesson`);
    const lessonId = db.prepare("SELECT id FROM lessons").pluck().get() as number;
    const empty = buildServer({ db, dataDir, llm: new FakeLlm({ text: () => ({ text: " ", references: [] }) }) });
    const lesson = await empty.inject({ method: "POST", url: `/api/concepts/${conceptIds[2]}/lesson` });
    expect(lesson.statusCode).toBe(502);
    const answer = await empty.inject({ method: "POST", url: `/api/lessons/${lessonId}/messages`, payload: { text: "Why?" } });
    expect(answer.statusCode).toBe(502);
    expect(db.prepare("SELECT COUNT(*) FROM lessons").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM lesson_messages").pluck().get()).toBe(0);
  });

  it("needs a model to write a lesson", async () => {
    const noModel = buildServer({ db, dataDir, llm: null, llmError: "No provider is selected." });
    const response = await noModel.inject({ method: "POST", url: `/api/concepts/${conceptIds[1]}/lesson` });
    expect(response.statusCode).toBe(503);
  });
});

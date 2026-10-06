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
import { defaultTestQuestions, FakeLlm } from "./fakes/llm.js";

let db: Db;
let app: TutorServer;
let llm: FakeLlm;
let conceptIds: number[];
let dataDir: string;

beforeEach(async () => {
  const data = await buildEpub(mainFixture());
  const book = await parseEpub(data);
  dataDir = mkdtempSync(join(tmpdir(), "tutor-check-"));
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
const correctIndex = (questionId: number) => String(db.prepare("SELECT answer FROM questions WHERE id = ?").pluck().get(questionId));

// Start a lesson for the concept, then the test. The function returns the test session.
async function startTest(conceptId: number): Promise<SessionView> {
  await post(`/api/concepts/${conceptId}/lesson`);
  const { body } = await post<{ sessionId: number }>(`/api/concepts/${conceptId}/check`);
  await app.idle();
  return get<SessionView>(`/api/sessions/${body.sessionId}`);
}

// Answer the questions in their order: right or wrong for each.
async function answer(session: SessionView, right: boolean[]): Promise<SessionView> {
  for (const [i, question] of session.questions.entries()) {
    const wrongOption = String((Number(correctIndex(question.id)) + 1) % 4);
    const text = question.kind === "choice" ? (right[i] ? correctIndex(question.id) : wrongOption) : right[i] ? "It has the point." : "No idea.";
    await post(`/api/questions/${question.id}/answer`, { answer: text });
  }
  return (await post<SessionView>(`/api/sessions/${session.id}/finish`)).body;
}

describe("the test after a lesson", () => {
  it("needs a lesson first", async () => {
    expect((await post(`/api/concepts/${conceptIds[1]}/check`)).status).toBe(409);
  });

  it("asks a recall, an explain, and an apply question", async () => {
    const session = await startTest(conceptIds[1]!);
    expect(session).toMatchObject({ kind: "test", status: "ready", concept: { id: conceptIds[1] } });
    expect(session.questions.map((question) => question.kind)).toEqual(["choice", "short", "apply"]);
    expect(db.prepare("SELECT DISTINCT purpose FROM questions WHERE session_id = ?").pluck().all(session.id)).toEqual(["test"]);
  });

  it("tests a mastered concept again with the questions of its last test, and with no model call", async () => {
    const id = conceptIds[1]!;
    const first = await startTest(id);
    expect((await answer(first, [true, true, true])).outcome!.passed).toBe(true);
    expect((await get<LessonView>(`/api/concepts/${id}/lesson`)).hasFinishedTest).toBe(true);

    const { body } = await post<{ sessionId: number }>(`/api/concepts/${id}/check`, { again: true });
    const again = await get<SessionView>(`/api/sessions/${body.sessionId}`);
    expect(again.id).not.toBe(first.id);
    expect(again.status).toBe("ready");
    expect(llm.count("test")).toBe(1);
    expect(again.questions.map((question) => [question.kind, question.text])).toEqual(first.questions.map((question) => [question.kind, question.text]));
    // The recall question has the same options. The order can change, and the answer follows its option.
    const options = (session: SessionView) => [...session.questions[0]!.choices!].sort();
    expect(options(again)).toEqual(options(first));
    const rightOption = (session: SessionView) => session.questions[0]!.choices![Number(correctIndex(session.questions[0]!.id))];
    expect(rightOption(again)).toBe(rightOption(first));
    expect(again.questions.every((question) => question.attempt === null)).toBe(true);

    // A pass keeps the concept mastered. A fail also keeps it mastered, until the learner chooses an action.
    expect((await answer(again, [true, true, true])).outcome!.passed).toBe(true);
    expect(statusOf(id)).toBe("mastered");
    const third = await get<SessionView>(`/api/sessions/${(await post<{ sessionId: number }>(`/api/concepts/${id}/check`, { again: true })).body.sessionId}`);
    expect((await answer(third, [false, false, false])).outcome!.passed).toBe(false);
    expect(statusOf(id)).toBe("mastered");
    expect(llm.count("test")).toBe(1);
  });

  it("writes new questions to test again a concept with no finished test", async () => {
    const id = conceptIds[1]!;
    await post(`/api/concepts/${id}/lesson`);
    await post(`/api/concepts/${id}/skip-test`);
    expect((await get<LessonView>(`/api/concepts/${id}/lesson`)).hasFinishedTest).toBe(false);
    const { body } = await post<{ sessionId: number }>(`/api/concepts/${id}/check`, { again: true });
    await app.idle();
    expect((await get<SessionView>(`/api/sessions/${body.sessionId}`)).questions.length).toBe(3);
    expect(llm.count("test")).toBe(1);
  });

  it("uses an unfinished test again", async () => {
    const first = await startTest(conceptIds[1]!);
    const again = await post<{ sessionId: number }>(`/api/concepts/${conceptIds[1]}/check`);
    expect(again.body.sessionId).toBe(first.id);
    expect((await get<LessonView>(`/api/concepts/${conceptIds[1]}/lesson`)).openTestId).toBe(first.id);
    expect(llm.count("test")).toBe(1);
  });

  it("passes with a correct answer to each question, and offers the next concept", async () => {
    await post(`/api/concepts/${conceptIds[2]}/top`);
    await post(`/api/concepts/${conceptIds[3]}/top`);
    const finished = await answer(await startTest(conceptIds[1]!), [true, true, true]);
    expect(finished.outcome).toMatchObject({ passed: true, correct: 3, total: 3, failedTests: 0 });
    expect(finished.outcome!.next).toMatchObject({ conceptId: conceptIds[3] });
    expect(statusOf(conceptIds[1]!)).toBe("mastered");
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id = ?").pluck().get(conceptIds[1])).toBeNull();
  });

  it("fails if one answer is not correct", async () => {
    const finished = await answer(await startTest(conceptIds[1]!), [false, true, true]);
    expect(finished.outcome).toMatchObject({ passed: false, correct: 2, total: 3, failedTests: 1, next: null });
    expect(statusOf(conceptIds[1]!)).toBe("learning");
    expect((await get<LessonView>(`/api/concepts/${conceptIds[1]}/lesson`)).failedTests).toBe(1);
  });

  it("asks one question for a simple concept, and passes with one correct answer", async () => {
    llm = new FakeLlm({ test: (_, sources) => ({ questions: defaultTestQuestions(sources[0]!.id).slice(2) }) });
    app = buildServer({ db, dataDir, llm });
    const session = await startTest(conceptIds[1]!);
    expect(session.questions.map((question) => question.kind)).toEqual(["apply"]);
    expect((await answer(session, [true])).outcome).toMatchObject({ passed: true, correct: 1, total: 1 });
  });

  it("keeps at most 3 questions", async () => {
    llm = new FakeLlm({ test: (_, sources) => ({ questions: [...defaultTestQuestions(sources[0]!.id), ...defaultTestQuestions(sources[0]!.id)] }) });
    app = buildServer({ db, dataDir, llm });
    expect((await startTest(conceptIds[1]!)).questions.length).toBe(3);
  });

  it("does not use a test with only recall questions, because a guess can pass it", async () => {
    llm = new FakeLlm({ test: (_, sources) => ({ questions: defaultTestQuestions(sources[0]!.id).slice(0, 1) }) });
    app = buildServer({ db, dataDir, llm });
    const session = await startTest(conceptIds[1]!);
    expect(session).toMatchObject({ status: "failed", error: "The model wrote no usable questions." });
    expect(llm.count("test")).toBe(2);
  });

  it("writes new questions for a second test, with the questions that the learner saw", async () => {
    await answer(await startTest(conceptIds[1]!), [false, false, false]);
    await startTest(conceptIds[1]!);
    const prompt = llm.calls.filter((call) => call.stage === "test").at(-1)!.request.prompt;
    expect(prompt).toContain("The learner saw these questions before");
    expect(prompt).toContain("Use the concept in this case.");
  });

  it("teaches again from the wrong answers of the test", async () => {
    await answer(await startTest(conceptIds[1]!), [true, true, false]);
    await post(`/api/concepts/${conceptIds[1]}/lesson`, { again: true });
    const request = llm.calls.filter((call) => call.stage === "lesson").at(-1)!.textRequest!.messages[0]!.content;
    expect(request).toContain("Use the concept in this case.");
    expect(request).toContain("Teach it again from a different angle");
  });

  it("puts a failed concept at the end of the queue with later, or skips it", async () => {
    await post(`/api/concepts/${conceptIds[2]}/top`);
    await answer(await startTest(conceptIds[1]!), [false, false, false]);
    await post(`/api/concepts/${conceptIds[1]}/after-test`, { action: "later" });
    const order = db.prepare("SELECT id FROM concepts WHERE queue_pos IS NOT NULL ORDER BY queue_pos").pluck().all();
    expect(order.at(-1)).toBe(conceptIds[1]);
    expect(statusOf(conceptIds[1]!)).toBe("queued");

    await post(`/api/concepts/${conceptIds[1]}/after-test`, { action: "skip" });
    expect(statusOf(conceptIds[1]!)).toBe("skipped");
    expect((await post(`/api/concepts/${conceptIds[1]}/after-test`, { action: "other" })).status).toBe(400);
  });

  it("marks a test as failed if the server stopped before the questions were ready", async () => {
    await post(`/api/concepts/${conceptIds[1]}/lesson`);
    const { body } = await post<{ sessionId: number }>(`/api/concepts/${conceptIds[1]}/check`);
    await app.idle();
    db.prepare("UPDATE sessions SET status = 'preparing' WHERE id = ?").run(body.sessionId);
    const restarted = buildServer({ db, dataDir: "", llm });
    const session = (await restarted.inject({ method: "GET", url: `/api/sessions/${body.sessionId}` })).json() as SessionView;
    expect(session).toMatchObject({ status: "failed", error: "The tutor stopped before the questions were ready." });
  });

  it("tests the prerequisites of a concept", async () => {
    const [prerequisite, concept] = [conceptIds[0]!, conceptIds[1]!];
    db.prepare("DELETE FROM concept_prereqs").run();
    expect((await post(`/api/concepts/${concept}/test-prerequisites`)).status).toBe(409);
    db.prepare("INSERT INTO concept_prereqs (concept_id, prereq_id) VALUES (?, ?)").run(concept, prerequisite);
    const { body } = await post<{ sessionId: number }>(`/api/concepts/${concept}/test-prerequisites`);
    await app.idle();
    const session = await get<SessionView>(`/api/sessions/${body.sessionId}`);
    expect(session).toMatchObject({ kind: "diagnose", status: "ready", module: null });
    expect(new Set(session.questions.map((question) => question.conceptId))).toEqual(new Set([prerequisite]));
  });
});

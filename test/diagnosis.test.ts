import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { parseEpub } from "../src/ingest/parse.js";
import type { SessionView } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { writeQuestions } from "../src/tutor/questions.js";
import { buildEpub, mainFixture } from "./fixtures/epub.js";
import { defaultQuestions, FakeLlm } from "./fakes/llm.js";

let db: Db;
let dataDir: string;
let app: TutorServer;
let llm: FakeLlm;
let moduleId: number;
let conceptIds: number[];

beforeEach(async () => {
  const data = await buildEpub(mainFixture());
  const book = await parseEpub(data);
  dataDir = mkdtempSync(join(tmpdir(), "tutor-diagnosis-"));
  const bookFile = join(dataDir, "fixture.epub");
  writeFileSync(bookFile, data);
  db = openDb(":memory:");
  await ingestBook({ llm: new FakeLlm(), db, dataDir, themeName: "Git", bookFile, book });
  llm = new FakeLlm();
  app = buildServer({ db, dataDir, llm });
  moduleId = db.prepare("SELECT id FROM modules LIMIT 1").pluck().get() as number;
  conceptIds = db.prepare("SELECT id FROM concepts WHERE module_id = ? ORDER BY id").pluck().all(moduleId) as number[];
});

const post = async <T>(url: string, body: unknown = {}) => {
  const response = await app.inject({ method: "POST", url, payload: body as object });
  return { status: response.statusCode, body: response.json() as T };
};
const get = async <T>(url: string) => (await app.inject({ method: "GET", url })).json() as T;
const statusOf = (id: number) => db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(id);

describe("selection", () => {
  it("puts Learn concepts into the queue in order, skips Skip concepts, and tests Test concepts", async () => {
    const [a, b, c, d] = conceptIds;
    const { body } = await post<{ sessionId: number; queued: number; skipped: number }>(`/api/modules/${moduleId}/selection`, {
      marks: { [a!]: "learn", [b!]: "skip", [c!]: "test", [d!]: "learn" },
    });
    expect(body).toMatchObject({ queued: 2, skipped: 1 });
    expect(statusOf(a!)).toBe("queued");
    expect(statusOf(b!)).toBe("skipped");
    expect(statusOf(c!)).toBe("to_test");
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id IN (?, ?) ORDER BY id").pluck().all(a, d)).toEqual([1, 2]);

    await app.idle();
    const session = await get<SessionView>(`/api/sessions/${body.sessionId}`);
    expect(session).toMatchObject({ status: "ready", prepared: 1, total: 1 });
    expect(session.questions.map((question) => question.kind)).toEqual(["choice", "short"]);
    // The correct answer stays hidden before the answer.
    expect(session.questions[0]!.attempt).toBeNull();
    expect(JSON.stringify(session)).not.toContain("The first option is right.");
  });

  it("changes earlier marks: later sets a concept back to new, and learn keeps the place in the queue", async () => {
    const [a, b, c] = conceptIds;
    await post(`/api/modules/${moduleId}/selection`, { marks: { [a!]: "learn", [b!]: "learn", [c!]: "skip" } });
    const { body } = await post<{ sessionId: number | null }>(`/api/modules/${moduleId}/selection`, {
      marks: { [a!]: "later", [b!]: "learn", [c!]: "learn" },
    });
    expect(body.sessionId).toBeNull();
    expect(statusOf(a!)).toBe("new");
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id = ?").pluck().get(a)).toBeNull();
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id IN (?, ?) ORDER BY id").pluck().all(b, c)).toEqual([2, 3]);
    expect(statusOf(c!)).toBe("queued");
  });

  it("needs no session without Test marks, and needs a model for Test marks", async () => {
    const { body } = await post<{ sessionId: number | null }>(`/api/modules/${moduleId}/selection`, { marks: { [conceptIds[0]!]: "skip" } });
    expect(body.sessionId).toBeNull();

    const noModel = buildServer({ db, dataDir: "data", llm: null, llmError: "No provider is selected." });
    const response = await noModel.inject({ method: "POST", url: `/api/modules/${moduleId}/selection`, payload: { marks: { [conceptIds[1]!]: "test" } } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "No provider is selected." });
    expect(statusOf(conceptIds[1]!)).toBe("new");
  });

  it("rejects a concept of another module", async () => {
    const { status } = await post(`/api/modules/${moduleId}/selection`, { marks: { 99999: "test" } });
    expect(status).toBe(400);
  });
});

describe("diagnosis", () => {
  async function startSession(ids: number[]): Promise<SessionView> {
    const marks = Object.fromEntries(ids.map((id) => [id, "test"]));
    const { body } = await post<{ sessionId: number }>(`/api/modules/${moduleId}/selection`, { marks });
    await app.idle();
    return get<SessionView>(`/api/sessions/${body.sessionId}`);
  }
  const correctIndex = (questionId: number) => Number(db.prepare("SELECT answer FROM questions WHERE id = ?").pluck().get(questionId));

  it("grades the answers, and marks each concept known or failed", async () => {
    const session = await startSession([conceptIds[0]!, conceptIds[1]!]);
    const [choiceA, openA, choiceB, openB] = session.questions;

    const right = await post<{ correct: boolean; correctIndex: number }>(`/api/questions/${choiceA!.id}/answer`, { answer: String(correctIndex(choiceA!.id)) });
    expect(right.body).toMatchObject({ correct: true, correctIndex: correctIndex(choiceA!.id) });
    expect((await post<{ score: number }>(`/api/questions/${openA!.id}/answer`, { answer: "It has the point." })).body.score).toBe(2);
    await post(`/api/questions/${choiceB!.id}/answer`, { answer: String(correctIndex(choiceB!.id)) });
    const wrong = await post<{ score: number; feedback: string; keyPoints: string[] }>(`/api/questions/${openB!.id}/answer`, { answer: "I do not know." });
    expect(wrong.body).toMatchObject({ score: 0, feedback: "You miss the point.", keyPoints: ["point"] });
    expect(llm.count("grade")).toBe(2);

    const finished = (await post<SessionView>(`/api/sessions/${session.id}/finish`)).body;
    expect(finished.status).toBe("finished");
    expect(finished.results!.map((result) => result.result)).toEqual(["known", "failed"]);
    expect(finished.results![1]!.wrong).toEqual([{ question: openB!.text, answer: "I do not know.", feedback: "You miss the point." }]);
    expect(statusOf(conceptIds[0]!)).toBe("known");
    expect(statusOf(conceptIds[1]!)).toBe("failed");

    await post(`/api/sessions/${session.id}/choices`, { choices: { [conceptIds[1]!]: "learn", [conceptIds[0]!]: "keep" } });
    expect(statusOf(conceptIds[1]!)).toBe("queued");
    expect(statusOf(conceptIds[0]!)).toBe("known");
  });

  it("counts a disputed answer as correct", async () => {
    const session = await startSession([conceptIds[0]!]);
    const [choice, open] = session.questions;
    await post(`/api/questions/${choice!.id}/answer`, { answer: String(correctIndex(choice!.id)) });
    const attempt = (await post<{ id: number }>(`/api/questions/${open!.id}/answer`, { answer: "nothing" })).body;
    expect((await post<{ correct: boolean; disputed: boolean }>(`/api/attempts/${attempt.id}/dispute`)).body).toMatchObject({ correct: true, disputed: true });
    expect((await post<SessionView>(`/api/sessions/${session.id}/finish`)).body.results![0]!.result).toBe("known");
  });

  it("retakes a question: the answer goes, and a new answer counts", async () => {
    const session = await startSession([conceptIds[0]!]);
    const [choice, open] = session.questions;
    const right = correctIndex(choice!.id);
    await post(`/api/questions/${choice!.id}/answer`, { answer: String(right === 0 ? 1 : 0) });
    await post(`/api/questions/${open!.id}/answer`, { answer: "The point." });

    expect((await post(`/api/questions/${choice!.id}/retake`)).status).toBe(200);
    const reopened = (await get<SessionView>(`/api/sessions/${session.id}`)).questions[0]!;
    expect(reopened.attempt).toBeNull();
    expect((await post<{ correct: boolean }>(`/api/questions/${choice!.id}/answer`, { answer: String(right) })).body.correct).toBe(true);
    expect((await post<SessionView>(`/api/sessions/${session.id}/finish`)).body.results![0]!.result).toBe("known");

    // After the results, the answers stay.
    expect((await post(`/api/questions/${choice!.id}/retake`)).status).toBe(409);
    expect((await post(`/api/questions/999/retake`)).status).toBe(404);
  });

  it("counts an unanswered question as wrong", async () => {
    const session = await startSession([conceptIds[0]!]);
    expect((await post<SessionView>(`/api/sessions/${session.id}/finish`)).body.results![0]).toMatchObject({ result: "failed" });
  });

  it("reports an error of the model, and can start again", async () => {
    const failing = buildServer({ db, dataDir, llm: new FakeLlm({ questions: () => { throw new Error("The model is not available."); } }) });
    const response = await failing.inject({ method: "POST", url: `/api/modules/${moduleId}/selection`, payload: { marks: { [conceptIds[0]!]: "test" } } });
    const sessionId = response.json<{ sessionId: number }>().sessionId;
    await failing.idle();
    const failed = (await failing.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json<SessionView>();
    expect(failed).toMatchObject({ status: "failed", error: "The model is not available." });

    expect((await post<SessionView>(`/api/sessions/${sessionId}/prepare`)).status).toBe(200);
    await app.idle();
    expect((await get<SessionView>(`/api/sessions/${sessionId}`)).status).toBe("ready");
  });
});

describe("writeQuestions", () => {
  const concept = (id: number, kind: "knowledge" | "skill" = "knowledge") => ({
    id,
    name: `Concept ${id}`,
    objective: "o",
    kind,
    sources: [{ sectionId: 10 + id, title: "t", markdown: "text" }],
  });

  it("shuffles the options and keeps the correct answer", async () => {
    const questions = await writeQuestions(new FakeLlm(), [concept(1)]);
    const choice = questions[0]!;
    expect(choice.choices).toHaveLength(4);
    expect(choice.choices![Number(choice.answer)]).toBe("right");
    expect(choice.sectionId).toBe(11);
  });

  it("asks again for a concept with no usable questions, and uses apply for a skill", async () => {
    let call = 0;
    const llm = new FakeLlm({
      questions: (ids, sources) => {
        call++;
        const answer = defaultQuestions(ids, sources);
        if (call === 1) answer.concepts[1]!.choice.correctIndex = 9;
        return answer;
      },
    });
    const questions = await writeQuestions(llm, [concept(1), concept(2, "skill")]);
    expect(call).toBe(2);
    expect(questions.map((question) => [question.conceptId, question.kind])).toEqual([
      [1, "choice"],
      [1, "short"],
      [2, "choice"],
      [2, "apply"],
    ]);
  });
});

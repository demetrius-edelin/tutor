import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { ingestBook } from "../src/ingest/ingest.js";
import { parseEpub } from "../src/ingest/parse.js";
import type { LlmClient } from "../src/llm/index.js";
import type { ConceptMapView, SessionView, SubjectDetail } from "../src/server/api-types.js";
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
  await ingestBook({ llm: new FakeLlm(), db, dataDir, subjectName: "Git", bookFile, book });
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
    const { body } = await post<{ sessionId: number; queued: number; skipped: number }>(`/api/subjects/git/selection`, {
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
    await post(`/api/subjects/git/selection`, { marks: { [a!]: "learn", [b!]: "learn", [c!]: "skip" } });
    const { body } = await post<{ sessionId: number | null }>(`/api/subjects/git/selection`, {
      marks: { [a!]: "later", [b!]: "learn", [c!]: "learn" },
    });
    expect(body.sessionId).toBeNull();
    expect(statusOf(a!)).toBe("new");
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id = ?").pluck().get(a)).toBeNull();
    expect(db.prepare("SELECT queue_pos FROM concepts WHERE id IN (?, ?) ORDER BY id").pluck().all(b, c)).toEqual([2, 3]);
    expect(statusOf(c!)).toBe("queued");
  });

  it("needs no session without Test marks, and needs a model for Test marks", async () => {
    const { body } = await post<{ sessionId: number | null }>(`/api/subjects/git/selection`, { marks: { [conceptIds[0]!]: "skip" } });
    expect(body.sessionId).toBeNull();

    const noModel = buildServer({ db, dataDir: "data", llm: null, llmError: "No provider is selected." });
    const response = await noModel.inject({ method: "POST", url: `/api/subjects/git/selection`, payload: { marks: { [conceptIds[1]!]: "test" } } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "No provider is selected." });
    expect(statusOf(conceptIds[1]!)).toBe("new");
  });

  it("tests concepts from more modules in one session, without a module", async () => {
    const [a, b] = conceptIds;
    const subjectId = db.prepare("SELECT subject_id FROM modules WHERE id = ?").pluck().get(moduleId);
    const other = db.prepare("INSERT INTO modules (subject_id, position, name) VALUES (?, 2, 'Other')").run(subjectId).lastInsertRowid;
    db.prepare("UPDATE concepts SET module_id = ? WHERE id = ?").run(other, b);

    const both = await post<{ sessionId: number }>(`/api/subjects/git/selection`, { marks: { [a!]: "test", [b!]: "test" } });
    expect((await get<SessionView>(`/api/sessions/${both.body.sessionId}`)).module).toBeNull();
    // A concept in the open diagnosis stays in it, so the diagnosis of one module uses another concept.
    const one = await post<{ sessionId: number }>(`/api/subjects/git/selection`, { marks: { [conceptIds[2]!]: "test" } });
    expect((await get<SessionView>(`/api/sessions/${one.body.sessionId}`)).module).toMatchObject({ id: moduleId });
    await app.idle();
  });

  it("rejects a concept of another subject, and an unknown subject", async () => {
    expect((await post(`/api/subjects/git/selection`, { marks: { 99999: "test" } })).status).toBe(400);
    expect((await post(`/api/subjects/other/selection`, { marks: { [conceptIds[0]!]: "skip" } })).status).toBe(404);
  });
});

describe("diagnosis", () => {
  async function startSession(ids: number[]): Promise<SessionView> {
    const marks = Object.fromEntries(ids.map((id) => [id, "test"]));
    const { body } = await post<{ sessionId: number }>(`/api/subjects/git/selection`, { marks });
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
    const response = await failing.inject({ method: "POST", url: `/api/subjects/git/selection`, payload: { marks: { [conceptIds[0]!]: "test" } } });
    const sessionId = response.json<{ sessionId: number }>().sessionId;
    await failing.idle();
    const failed = (await failing.inject({ method: "GET", url: `/api/sessions/${sessionId}` })).json<SessionView>();
    expect(failed).toMatchObject({ status: "failed", error: "The model is not available." });

    expect((await post<SessionView>(`/api/sessions/${sessionId}/prepare`)).status).toBe(200);
    await app.idle();
    expect((await get<SessionView>(`/api/sessions/${sessionId}`)).status).toBe("ready");
  });
});

describe("a diagnosis that did not finish", () => {
  const select = async (marks: Record<number, string>) =>
    (await post<{ sessionId: number }>(`/api/subjects/git/selection`, { marks })).body.sessionId;
  const conceptsOf = (session: SessionView) => [...new Set(session.questions.map((question) => question.conceptId))];

  it("shows the open diagnosis with its answers, and opens it again with no new questions", async () => {
    const [a, b, c] = conceptIds as [number, number, number];
    const first = await select({ [a]: "test", [b]: "test" });
    await app.idle();
    const session = await get<SessionView>(`/api/sessions/${first}`);
    await post(`/api/questions/${session.questions[0]!.id}/answer`, { answer: "0" });
    expect((await get<SubjectDetail>("/api/subjects/git")).openDiagnoses).toEqual([
      { sessionId: first, status: "ready", concepts: 2, questions: 4, answered: 1 },
    ]);
    const map = await get<ConceptMapView>("/api/subjects/git/map");
    expect(map.openDiagnoses).toHaveLength(1);
    expect(map.modules.flatMap((module) => module.concepts).filter((concept) => concept.diagnosis === first).map((concept) => concept.id)).toEqual([a, b]);

    // "Test it" for a concept in the open diagnosis opens that diagnosis. The model writes no new questions.
    const written = llm.count("questions");
    expect((await post<{ sessionId: number }>(`/api/concepts/${a}/test`)).body.sessionId).toBe(first);
    expect(await select({ [a]: "test", [b]: "test" })).toBe(first);
    // With a concept that is not in an open diagnosis, only that concept gets a new diagnosis.
    const second = await select({ [b]: "test", [c]: "test" });
    expect(second).not.toBe(first);
    await app.idle();
    expect(llm.count("questions")).toBe(written + 1);
    expect(conceptsOf(await get<SessionView>(`/api/sessions/${second}`))).toEqual([c]);
    expect(conceptsOf(await get<SessionView>(`/api/sessions/${first}`))).toEqual([a, b]);
    // The answer in the open diagnosis is still there.
    expect((await get<SubjectDetail>("/api/subjects/git")).openDiagnoses).toMatchObject([{ sessionId: first, answered: 1 }, { sessionId: second }]);
  });

  it("takes a concept with a new mark out of the open diagnosis, and keeps the new mark at the end", async () => {
    const [a, b, c] = conceptIds as [number, number, number];
    const first = await select({ [a]: "test", [b]: "test", [c]: "test" });
    await app.idle();
    await select({ [b]: "learn" });
    expect(statusOf(b)).toBe("queued");
    const session = await get<SessionView>(`/api/sessions/${first}`);
    expect(conceptsOf(session)).toEqual([a, c]);
    expect(session.total).toBe(2);

    // A concept that an earlier version of the tutor left in the diagnosis keeps its new mark at the end.
    db.prepare("UPDATE concepts SET status = 'skipped' WHERE id = ?").run(c);
    expect((await get<SubjectDetail>("/api/subjects/git")).openDiagnoses).toMatchObject([{ sessionId: first, concepts: 1 }]);
    await post(`/api/sessions/${first}/finish`);
    expect([statusOf(a), statusOf(b), statusOf(c)]).toEqual(["failed", "queued", "skipped"]);
    expect((await get<SubjectDetail>("/api/subjects/git")).openDiagnoses).toEqual([]);

    // A diagnosis with no concept left goes.
    const only = await select({ [a]: "test" });
    await app.idle();
    await select({ [a]: "skip" });
    expect(db.prepare("SELECT COUNT(*) FROM sessions WHERE id = ?").pluck().get(only)).toBe(0);
  });
});

// A model that holds its first request with a system prompt that starts with prefix, until the test calls release.
function holdingModel(prefix: string) {
  const fake = new FakeLlm();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  let first = true;
  const model: LlmClient = {
    object: async (request) => {
      if (first && request.system.startsWith(prefix)) {
        first = false;
        holding = true;
        await held;
      }
      return fake.object(request);
    },
    text: (request) => fake.text(request),
  };
  return { model, release: () => release(), holding: () => holding };
}

describe("a model request that ends late", () => {
  const select = async (server: TutorServer, marks: Record<number, string>) =>
    (await server.inject({ method: "POST", url: "/api/subjects/git/selection", payload: { marks } })).json<{ sessionId: number }>().sessionId;
  const view = async (server: TutorServer, id: number) => (await server.inject({ method: "GET", url: `/api/sessions/${id}` })).json<SessionView>();
  const answer = (server: TutorServer, id: number, text: string) =>
    server.inject({ method: "POST", url: `/api/questions/${id}/answer`, payload: { answer: text } });

  it("does not change a new session with the id of a removed session", async () => {
    const [a, b] = conceptIds as [number, number];
    const slow = holdingModel("You write diagnosis questions");
    const server = buildServer({ db, dataDir, llm: slow.model });
    const removed = await select(server, { [a]: "test" });
    await vi.waitFor(() => expect(slow.holding()).toBe(true));
    await select(server, { [a]: "learn" });
    const id = await select(server, { [b]: "test" });
    // SQLite gives the id of the removed session to the new session.
    expect(id).toBe(removed);
    await vi.waitFor(() => expect(db.prepare("SELECT status FROM sessions WHERE id = ?").pluck().get(id)).toBe("ready"));
    const session = await view(server, id);
    await answer(server, session.questions[0]!.id, "0");

    slow.release();
    await server.idle();
    const after = await view(server, id);
    expect(after).toMatchObject({ status: "ready", error: null });
    expect(after.questions.map((question) => question.id)).toEqual(session.questions.map((question) => question.id));
    expect(after.questions[0]!.attempt).not.toBeNull();
  });

  it("does not count a grade that comes after the results", async () => {
    const slow = holdingModel("You grade the answer");
    const server = buildServer({ db, dataDir, llm: slow.model });
    const id = await select(server, { [conceptIds[0]!]: "test" });
    await server.idle();
    const open = (await view(server, id)).questions.find((question) => question.kind !== "choice")!;
    const late = answer(server, open.id, "It has the point.");
    await vi.waitFor(() => expect(slow.holding()).toBe(true));
    const finished = (await server.inject({ method: "POST", url: `/api/sessions/${id}/finish` })).json<SessionView>();
    expect(finished.results![0]!.result).toBe("failed");

    slow.release();
    expect((await late).statusCode).toBe(409);
    const after = await view(server, id);
    expect(after.results).toEqual(finished.results);
    expect(after.questions.find((question) => question.id === open.id)!.attempt).toBeNull();
    expect(statusOf(conceptIds[0]!)).toBe("failed");
    // After the results, a question takes no new answer.
    expect((await answer(server, open.id, "It has the point.")).statusCode).toBe(409);
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

  it("writes only the open question for a simple concept, so that a guess cannot pass", async () => {
    const llm = new FakeLlm({
      questions: (ids, sources) => {
        const answer = defaultQuestions(ids, sources) as { concepts: { choice: unknown }[] };
        answer.concepts[0]!.choice = null;
        return answer;
      },
    });
    const questions = await writeQuestions(llm, [concept(1), concept(2)]);
    expect(questions.map((question) => [question.conceptId, question.kind])).toEqual([
      [1, "short"],
      [2, "choice"],
      [2, "short"],
    ]);
    expect(llm.calls[0]!.request.system).toContain("A simple concept gets only the open question");
  });
});

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Db } from "../db/index.js";
import type { LlmClient } from "../llm/index.js";
import type {
  AttemptView,
  Choice,
  ConceptResult,
  Mark,
  QuestionView,
  SessionView,
  Status,
  TestOutcome,
} from "../server/api-types.js";
import { gradeAnswer } from "./grader.js";
import { questionBatches, writeQuestions, writeTestQuestions, type QuestionConcept, type WrittenQuestion } from "./questions.js";

// The diagnosis: the learner marks concepts on the concept map, the tutor tests the concepts
// with the mark "test", and the learner chooses what to learn from the results.

export class TutorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TutorError";
  }
}

export function readSection(dataDir: string, path: string): string {
  const root = resolve(dataDir);
  const file = resolve(root, path);
  if (!file.startsWith(root + sep)) throw new TutorError("The section file is outside the data folder.", 500);
  return readFileSync(file, "utf8");
}

// Put a concept at the end of the study queue of its subject.
export function enqueue(db: Db, conceptId: number): void {
  const { subject_id: subjectId } = db.prepare("SELECT subject_id FROM concepts WHERE id = ?").get(conceptId) as { subject_id: number };
  const last = db.prepare("SELECT COALESCE(MAX(queue_pos), 0) FROM concepts WHERE subject_id = ?").pluck().get(subjectId) as number;
  db.prepare("UPDATE concepts SET status = 'queued', queue_pos = ? WHERE id = ?").run(last + 1, conceptId);
}

function setStatus(db: Db, conceptId: number, status: Status): void {
  db.prepare("UPDATE concepts SET status = ?, queue_pos = NULL WHERE id = ?").run(status, conceptId);
}

// A new session with its concepts. The questions come later, from prepareSession.
export function createSession(db: Db, subjectId: number, moduleId: number | null, conceptIds: number[], kind: "diagnose" | "test"): number {
  const sessionId = Number(
    db
      .prepare("INSERT INTO sessions (subject_id, module_id, kind, status, total) VALUES (?, ?, ?, 'preparing', ?)")
      .run(subjectId, moduleId, kind, conceptIds.length).lastInsertRowid,
  );
  const insert = db.prepare("INSERT INTO session_concepts (session_id, concept_id) VALUES (?, ?)");
  for (const id of conceptIds) insert.run(sessionId, id);
  return sessionId;
}

// Apply the marks of the learner for concepts of one subject, from any module. A concept without a mark
// does not change. A mark can also change an earlier mark, for example "learn" to "test".
// The concepts with the mark "test" get a new diagnosis session. The function returns the session id, or null.
export function applyMarks(db: Db, subjectSlug: string, marks: Record<string, Mark>): { sessionId: number | null; queued: number; skipped: number } {
  const subjectId = db.prepare("SELECT id FROM subjects WHERE slug = ?").pluck().get(subjectSlug) as number | undefined;
  if (subjectId === undefined) throw new TutorError(`The subject "${subjectSlug}" does not exist.`, 404);
  const moduleOf = new Map(
    (db.prepare("SELECT id, module_id FROM concepts WHERE subject_id = ?").all(subjectId) as { id: number; module_id: number }[]).map(
      (row) => [row.id, row.module_id],
    ),
  );
  const entries = Object.entries(marks).map(([id, mark]) => [Number(id), mark] as const);
  for (const [id, mark] of entries) {
    if (!moduleOf.has(id)) throw new TutorError(`The concept ${id} is not in the subject "${subjectSlug}".`);
    if (!["test", "learn", "skip", "later"].includes(mark)) throw new TutorError(`"${mark}" is not a valid mark.`);
  }

  return db.transaction(() => {
    let queued = 0;
    let skipped = 0;
    const toTest: number[] = [];
    for (const [id, mark] of entries) {
      if (mark === "learn") {
        // A concept in the queue keeps its place.
        const status = db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(id);
        if (status !== "queued") enqueue(db, id);
        queued++;
      } else if (mark === "later") {
        setStatus(db, id, "new");
      } else if (mark === "skip") {
        setStatus(db, id, "skipped");
        skipped++;
      } else {
        setStatus(db, id, "to_test");
        toTest.push(id);
      }
    }
    if (toTest.length === 0) return { sessionId: null, queued, skipped };
    // A diagnosis of concepts from one module belongs to that module. A diagnosis of concepts from more modules has no module.
    const modules = new Set(toTest.map((id) => moduleOf.get(id)!));
    const moduleId = modules.size === 1 ? [...modules][0]! : null;
    return { sessionId: createSession(db, subjectId, moduleId, toTest, "diagnose"), queued, skipped };
  })();
}

function questionConcepts(db: Db, dataDir: string, sessionId: number): QuestionConcept[] {
  const concepts = db
    .prepare(
      `SELECT c.id, c.name, c.objective, c.kind FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
       WHERE sc.session_id = ? ORDER BY c.id`,
    )
    .all(sessionId) as Omit<QuestionConcept, "sources">[];
  const sources = db.prepare(
    `SELECT s.id AS sectionId, b.title || ' > ' || s.title AS title, s.path FROM concept_sources cs
     JOIN sections s ON s.id = cs.section_id JOIN books b ON b.id = s.book_id WHERE cs.concept_id = ? ORDER BY s.id`,
  );
  return concepts.map((concept) => ({
    ...concept,
    sources: (sources.all(concept.id) as { sectionId: number; title: string; path: string }[]).map((source) => ({
      sectionId: source.sectionId,
      title: source.title,
      markdown: readSection(dataDir, source.path),
    })),
  }));
}

// A new server has no running jobs. A session that is still "preparing" lost its job, for example after a restart.
// The session becomes "failed", and the learner can start the job again with "Try again".
export function failInterruptedSessions(db: Db): void {
  db.prepare("UPDATE sessions SET status = 'failed', error = ? WHERE status = 'preparing'").run(
    "The tutor stopped before the questions were ready.",
  );
}

// Write the questions of a session. The function runs in the background. It saves the questions
// of each group of concepts at once, so that the app can show the progress.
// A diagnosis gets 2 questions for each concept. A test after a lesson gets the new questions that fit the concept.
export async function prepareSession(db: Db, llm: LlmClient, dataDir: string, sessionId: number): Promise<void> {
  try {
    db.prepare("UPDATE sessions SET status = 'preparing', error = NULL WHERE id = ?").run(sessionId);
    db.prepare("DELETE FROM questions WHERE session_id = ?").run(sessionId);
    const kind = db.prepare("SELECT kind FROM sessions WHERE id = ?").pluck().get(sessionId) as "diagnose" | "test";
    const concepts = questionConcepts(db, dataDir, sessionId);
    const insert = db.prepare(
      `INSERT INTO questions (concept_id, purpose, kind, text, choices, answer, key_points, section_id, session_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let position = 0;
    let prepared = 0;
    const batches: QuestionConcept[][] = kind === "test" ? concepts.map((concept) => [concept]) : questionBatches(concepts);
    for (const batch of batches) {
      let questions: WrittenQuestion[];
      if (kind === "test") {
        // A test again copies old questions, so one text can be in more than one row.
        const seen = db.prepare("SELECT text FROM questions WHERE concept_id = ? GROUP BY text ORDER BY MIN(id)").pluck().all(batch[0]!.id) as string[];
        questions = await writeTestQuestions(llm, batch[0]!, seen);
      } else {
        questions = await writeQuestions(llm, batch);
      }
      db.transaction(() => {
        for (const question of questions) {
          insert.run(
            question.conceptId,
            kind,
            question.kind,
            question.text,
            question.choices ? JSON.stringify(question.choices) : null,
            question.answer,
            JSON.stringify(question.keyPoints),
            question.sectionId,
            sessionId,
            position++,
          );
        }
        prepared += new Set(questions.map((question) => question.conceptId)).size;
        db.prepare("UPDATE sessions SET prepared = ? WHERE id = ?").run(prepared, sessionId);
      })();
    }
    const status = position > 0 ? "ready" : "failed";
    const error = position > 0 ? null : "The model wrote no usable questions.";
    db.prepare("UPDATE sessions SET status = ?, error = ? WHERE id = ?").run(status, error, sessionId);
  } catch (error) {
    db.prepare("UPDATE sessions SET status = 'failed', error = ? WHERE id = ?").run(
      error instanceof Error ? error.message : String(error),
      sessionId,
    );
  }
}

interface QuestionRow {
  id: number;
  concept_id: number;
  concept_name: string;
  kind: QuestionView["kind"];
  text: string;
  choices: string | null;
  answer: string;
  key_points: string;
  section_id: number | null;
  chapter: number | null;
  number: number | null;
  section_title: string | null;
  page: string | null;
}

interface AttemptRow {
  id: number;
  question_id: number;
  answer: string;
  score: number;
  feedback: string;
  disputed: number;
}

function attemptView(attempt: AttemptRow, question: Pick<QuestionRow, "kind" | "answer" | "key_points">): AttemptView {
  const keyPoints = JSON.parse(question.key_points) as string[];
  return {
    id: attempt.id,
    answer: attempt.answer,
    score: attempt.score,
    correct: attempt.score === 2 || attempt.disputed === 1,
    disputed: attempt.disputed === 1,
    feedback: attempt.feedback,
    correctIndex: question.kind === "choice" ? Number(question.answer) : null,
    keyPoints,
    modelAnswer: question.kind === "choice" ? null : question.answer,
  };
}

const QUESTION_SELECT = `SELECT q.id, q.concept_id, c.name AS concept_name, q.kind, q.text, q.choices, q.answer, q.key_points, q.section_id,
  s.chapter, s.number, s.title AS section_title, s.page
  FROM questions q JOIN concepts c ON c.id = q.concept_id LEFT JOIN sections s ON s.id = q.section_id`;

function latestAttempts(db: Db, questionIds: number[]): Map<number, AttemptRow> {
  const attempts = new Map<number, AttemptRow>();
  if (questionIds.length === 0) return attempts;
  const rows = db
    .prepare(`SELECT id, question_id, answer, score, feedback, disputed FROM attempts WHERE question_id IN (${questionIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...questionIds) as AttemptRow[];
  for (const row of rows) attempts.set(row.question_id, row);
  return attempts;
}

export function sessionView(db: Db, sessionId: number): SessionView {
  const session = db
    .prepare(
      `SELECT ss.id, ss.kind, ss.status, ss.error, ss.prepared, ss.total, sub.slug AS subject_slug, sub.name AS subject_name,
         m.id AS module_id, m.position AS module_position, m.name AS module_name
       FROM sessions ss JOIN subjects sub ON sub.id = ss.subject_id LEFT JOIN modules m ON m.id = ss.module_id WHERE ss.id = ?`,
    )
    .get(sessionId) as
    | {
        id: number;
        kind: SessionView["kind"];
        status: SessionView["status"];
        error: string | null;
        prepared: number;
        total: number;
        subject_slug: string;
        subject_name: string;
        module_id: number | null;
        module_position: number | null;
        module_name: string | null;
      }
    | undefined;
  if (!session) throw new TutorError(`The session ${sessionId} does not exist.`, 404);

  const questions = db.prepare(`${QUESTION_SELECT} WHERE q.session_id = ? ORDER BY q.position`).all(sessionId) as QuestionRow[];
  const attempts = latestAttempts(db, questions.map((question) => question.id));
  return {
    id: session.id,
    subject: { slug: session.subject_slug, name: session.subject_name },
    module:
      session.module_id === null ? null : { id: session.module_id, position: session.module_position!, name: session.module_name! },
    kind: session.kind,
    status: session.status,
    error: session.error,
    prepared: session.prepared,
    total: session.total,
    questions: questions.map((question) => {
      const attempt = attempts.get(question.id);
      return {
        id: question.id,
        conceptId: question.concept_id,
        conceptName: question.concept_name,
        kind: question.kind,
        text: question.text,
        choices: question.choices ? (JSON.parse(question.choices) as string[]) : null,
        source:
          question.section_id === null
            ? null
            : { sectionId: question.section_id, ref: `${question.chapter}.${question.number}`, title: question.section_title!, page: question.page },
        // The correct answer stays hidden until the learner answers.
        attempt: attempt ? attemptView(attempt, question) : null,
      };
    }),
    results: session.status === "finished" ? sessionResults(db, sessionId) : null,
    concept: session.kind === "test" ? sessionConcept(db, sessionId) : null,
    outcome: session.kind === "test" && session.status === "finished" ? testOutcome(db, sessionId) : null,
  };
}

function sessionConcept(db: Db, sessionId: number): SessionView["concept"] {
  return (
    (db
      .prepare("SELECT c.id, c.slug, c.name FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id WHERE sc.session_id = ?")
      .get(sessionId) as SessionView["concept"] | undefined) ?? null
  );
}

const isCorrect = (attempt: AttemptRow | undefined) => attempt !== undefined && (attempt.score === 2 || attempt.disputed === 1);

// The pass rule of a test: each question has a correct answer.
function testScore(db: Db, sessionId: number): { correct: number; total: number; passed: boolean } {
  const questions = db.prepare("SELECT id FROM questions WHERE session_id = ? ORDER BY position").pluck().all(sessionId) as number[];
  const attempts = latestAttempts(db, questions);
  const correct = questions.filter((id) => isCorrect(attempts.get(id))).length;
  return { correct, total: questions.length, passed: questions.length > 0 && correct === questions.length };
}

function testOutcome(db: Db, sessionId: number): TestOutcome {
  const concept = sessionConcept(db, sessionId)!;
  const { passed, correct, total } = testScore(db, sessionId);
  const subjectId = db.prepare("SELECT subject_id FROM concepts WHERE id = ?").pluck().get(concept.id) as number;
  const next = passed
    ? ((db
        .prepare(
          "SELECT id AS conceptId, name FROM concepts WHERE subject_id = ? AND status IN ('queued', 'learning') AND id <> ? ORDER BY queue_pos, id LIMIT 1",
        )
        .get(subjectId, concept.id) as TestOutcome["next"] | undefined) ?? null)
    : null;
  return {
    passed,
    correct,
    total,
    failedTests: failedTests(db, concept.id),
    hasPrerequisites: (db.prepare("SELECT COUNT(*) FROM concept_prereqs WHERE concept_id = ?").pluck().get(concept.id) as number) > 0,
    next,
  };
}

// The number of finished tests after a lesson that the learner failed for a concept.
export function failedTests(db: Db, conceptId: number): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM sessions s JOIN session_concepts sc ON sc.session_id = s.id
       WHERE s.kind = 'test' AND s.status = 'finished' AND sc.concept_id = ? AND sc.result = 'failed'`,
    )
    .pluck()
    .get(conceptId) as number;
}

export async function answerQuestion(db: Db, llm: LlmClient | null, dataDir: string, questionId: number, answer: string): Promise<AttemptView> {
  const question = db
    .prepare(`${QUESTION_SELECT} WHERE q.id = ?`)
    .get(questionId) as (QuestionRow & { path?: string }) | undefined;
  if (!question) throw new TutorError(`The question ${questionId} does not exist.`, 404);
  const existing = latestAttempts(db, [questionId]).get(questionId);
  if (existing) return attemptView(existing, question);

  let score: number;
  let feedback: string;
  if (question.kind === "choice") {
    const correct = Number(question.answer);
    score = Number(answer) === correct ? 2 : 0;
    feedback = score === 2 ? "Correct." : "Not correct.";
  } else {
    if (!llm) throw new TutorError("No model is set. Set the model in .env and start the tutor again.", 503);
    const path = question.section_id === null ? undefined : (db.prepare("SELECT path FROM sections WHERE id = ?").pluck().get(question.section_id) as string);
    const grade = await gradeAnswer(llm, {
      question: question.text,
      keyPoints: JSON.parse(question.key_points) as string[],
      modelAnswer: question.answer,
      answer,
      source: path ? { id: String(question.section_id), title: question.section_title ?? "Section", text: readSection(dataDir, path) } : null,
    });
    score = grade.score;
    feedback = grade.feedback;
  }
  const id = Number(
    db.prepare("INSERT INTO attempts (question_id, answer, score, feedback) VALUES (?, ?, ?, ?)").run(questionId, answer, score, feedback)
      .lastInsertRowid,
  );
  return attemptView({ id, question_id: questionId, answer, score, feedback, disputed: 0 }, question);
}

// Retake a question: remove its answers, so that the learner can answer it again.
// The answers of a finished session stay, because the results come from them.
export function retakeQuestion(db: Db, questionId: number): void {
  const question = db
    .prepare("SELECT s.status FROM questions q LEFT JOIN sessions s ON s.id = q.session_id WHERE q.id = ?")
    .get(questionId) as { status: string | null } | undefined;
  if (!question) throw new TutorError(`The question ${questionId} does not exist.`, 404);
  if (question.status === "finished") throw new TutorError("You cannot retake a question after the results.", 409);
  db.prepare("DELETE FROM attempts WHERE question_id = ?").run(questionId);
}

// A disputed answer counts as correct. The record of the case helps to improve the grader.
export function disputeAttempt(db: Db, attemptId: number): AttemptView {
  const attempt = db.prepare("SELECT id, question_id, answer, score, feedback, disputed FROM attempts WHERE id = ?").get(attemptId) as
    | AttemptRow
    | undefined;
  if (!attempt) throw new TutorError(`The answer ${attemptId} does not exist.`, 404);
  db.prepare("UPDATE attempts SET disputed = 1 WHERE id = ?").run(attemptId);
  const question = db.prepare("SELECT kind, answer, key_points FROM questions WHERE id = ?").get(attempt.question_id) as Pick<
    QuestionRow,
    "kind" | "answer" | "key_points"
  >;
  return attemptView({ ...attempt, disputed: 1 }, question);
}

function sessionResults(db: Db, sessionId: number): ConceptResult[] {
  const concepts = db
    .prepare(
      `SELECT c.id, c.slug, c.name, c.status, sc.result FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
       WHERE sc.session_id = ? ORDER BY c.id`,
    )
    .all(sessionId) as { id: number; slug: string; name: string; status: Status; result: "known" | "failed" | null }[];
  const questions = db.prepare(`${QUESTION_SELECT} WHERE q.session_id = ? ORDER BY q.position`).all(sessionId) as QuestionRow[];
  const attempts = latestAttempts(db, questions.map((question) => question.id));
  return concepts.map((concept) => ({
    conceptId: concept.id,
    slug: concept.slug,
    name: concept.name,
    result: concept.result ?? "none",
    status: concept.status,
    wrong: questions
      .filter((question) => question.concept_id === concept.id)
      .flatMap((question) => {
        const attempt = attempts.get(question.id);
        if (attempt && (attempt.score === 2 || attempt.disputed === 1)) return [];
        const answer = !attempt
          ? "(no answer)"
          : question.kind === "choice"
            ? ((JSON.parse(question.choices ?? "[]") as string[])[Number(attempt.answer)] ?? attempt.answer)
            : attempt.answer;
        return [{ question: question.text, answer, feedback: attempt?.feedback ?? "" }];
      }),
  }));
}

// End the diagnosis: a concept is known if each of its questions has a correct answer.
// An unanswered question counts as wrong. A concept with no questions goes back to "new".
export function finishSession(db: Db, sessionId: number): SessionView {
  const session = db.prepare("SELECT status, kind FROM sessions WHERE id = ?").get(sessionId) as { status: string; kind: string } | undefined;
  if (!session) throw new TutorError(`The session ${sessionId} does not exist.`, 404);
  if (session.status === "finished") return sessionView(db, sessionId);
  if (session.status !== "ready") throw new TutorError("The questions of this session are not ready.", 409);

  // A test after a lesson: a pass makes the concept mastered and takes it out of the queue.
  // After a fail, the concept stays in its lesson, and the learner chooses the next step.
  if (session.kind === "test") {
    const concept = sessionConcept(db, sessionId)!;
    const { passed } = testScore(db, sessionId);
    db.transaction(() => {
      if (passed) setStatus(db, concept.id, "mastered");
      db.prepare("UPDATE session_concepts SET result = ? WHERE session_id = ?").run(passed ? "known" : "failed", sessionId);
      db.prepare("UPDATE sessions SET status = 'finished' WHERE id = ?").run(sessionId);
    })();
    return sessionView(db, sessionId);
  }

  const questions = db.prepare("SELECT id, concept_id FROM questions WHERE session_id = ?").all(sessionId) as { id: number; concept_id: number }[];
  const attempts = latestAttempts(db, questions.map((question) => question.id));
  const conceptIds = db.prepare("SELECT concept_id FROM session_concepts WHERE session_id = ?").pluck().all(sessionId) as number[];
  db.transaction(() => {
    for (const conceptId of conceptIds) {
      const own = questions.filter((question) => question.concept_id === conceptId);
      if (own.length === 0) {
        setStatus(db, conceptId, "new");
        continue;
      }
      const known = own.every((question) => {
        const attempt = attempts.get(question.id);
        return attempt !== undefined && (attempt.score === 2 || attempt.disputed === 1);
      });
      setStatus(db, conceptId, known ? "known" : "failed");
      db.prepare("UPDATE session_concepts SET result = ? WHERE session_id = ? AND concept_id = ?").run(known ? "known" : "failed", sessionId, conceptId);
    }
    db.prepare("UPDATE sessions SET status = 'finished' WHERE id = ?").run(sessionId);
  })();
  return sessionView(db, sessionId);
}

// The choices of the learner after the results: learn puts the concept in the study queue,
// skip skips it, and keep changes nothing.
export function applyChoices(db: Db, sessionId: number, choices: Record<string, Choice>): { queued: number; skipped: number } {
  const conceptIds = new Set(db.prepare("SELECT concept_id FROM session_concepts WHERE session_id = ?").pluck().all(sessionId) as number[]);
  if (conceptIds.size === 0) throw new TutorError(`The session ${sessionId} does not exist.`, 404);
  let queued = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const [id, choice] of Object.entries(choices)) {
      const conceptId = Number(id);
      if (!conceptIds.has(conceptId)) throw new TutorError(`The concept ${id} is not in the session ${sessionId}.`);
      if (choice === "learn") {
        enqueue(db, conceptId);
        queued++;
      } else if (choice === "skip") {
        setStatus(db, conceptId, "skipped");
        skipped++;
      } else if (choice !== "keep") {
        throw new TutorError(`"${choice}" is not a valid choice.`);
      }
    }
  })();
  return { queued, skipped };
}

import type { Db } from "../db/index.js";
import type { LlmClient, Message, Reference, Source } from "../llm/index.js";
import type { AfterTestAction, LessonMessage, LessonReference, LessonView, SourceInfo, Status } from "../server/api-types.js";
import { applyMarks, createSession, enqueue, failedTests, readSection, TutorError } from "./diagnosis.js";
import { shuffle } from "./questions.js";

// A lesson: the model teaches one concept from all its book sections, with references.
// The length of the lesson follows the concept, so a simple concept gets a short lesson.
// After the lesson, the learner can ask questions. The model answers with the same sources.

// The rules for the sources. The lesson and the answers in the chat use the same rules.
const SOURCE_RULES = `- Base the text on the sources. If you add a fact or a claim that is not in the sources, mark it with "(not from the books)".
- Put the marker one time at the end of the paragraph or the list item, not after each sentence.
- Do not mark the standard behavior of a language or a tool. Do not mark the step-by-step explanation of an example.
- If a source has an error or contradicts itself, say so in one sentence. Then teach the correct form. Do not discuss the source more.
- A source can contain "[Image]" or "[Image: description]". The content of the image is not available. Do not guess what it shows.`;

export const LESSON_SYSTEM = `You are a tutor. You teach one concept to one learner, from the sources of the books of the learner.
Write the lesson in Markdown with these parts, in this order:
## Explanation
An explanation in plain words. Start with what the learner must know first.
## Example
One example. Add a second example only for a complex concept. Choose the type of example from the sources, for example a query, a code sample, or a worked case. Explain each example.
## Common mistakes
0 to 4 short points. Write only the mistakes that learners really make with this concept. If there is no such mistake, do not write this part.
## Summary
1 or 2 sentences. Write this part only for a lesson of more than 600 words.
Length:
- The length follows the concept. A simple concept needs about 150 to 300 words. Use up to 1200 words only for a complex concept. The code of the examples does not count.
- Do not add content to reach a length. Stop when the concept is clear.
Rules:
${SOURCE_RULES}
- The learner is an experienced software developer. Do not explain basic programming.`;

export const CHAT_SYSTEM = `You are a tutor. The learner read your lesson and asks a question about it.
Answer in 1 to 3 short paragraphs. Use an example if it helps.
If the question is not about the concept, answer it briefly and lead back to the concept.
Rules:
${SOURCE_RULES}`;

// The maximum number of book sections in a lesson, so that the request stays small.
const MAX_SECTIONS = 6;
const READY: Status[] = ["known", "mastered"];

interface ConceptRow {
  id: number;
  theme_id: number;
  slug: string;
  name: string;
  objective: string;
  kind: "knowledge" | "skill";
  level: "basic" | "intermediate" | "advanced";
  status: Status;
  starred: number;
  queue_pos: number | null;
  theme_slug: string;
  theme_name: string;
  module_id: number;
  module_position: number;
  module_name: string;
}

function conceptRow(db: Db, conceptId: number): ConceptRow {
  const row = db
    .prepare(
      `SELECT c.id, c.theme_id, c.slug, c.name, c.objective, c.kind, c.level, c.status, c.starred, c.queue_pos,
         t.slug AS theme_slug, t.name AS theme_name, m.id AS module_id, m.position AS module_position, m.name AS module_name
       FROM concepts c JOIN themes t ON t.id = c.theme_id JOIN modules m ON m.id = c.module_id WHERE c.id = ?`,
    )
    .get(conceptId) as ConceptRow | undefined;
  if (!row) throw new TutorError(`The concept ${conceptId} does not exist.`, 404);
  return row;
}

function sourcesOf(db: Db, conceptId: number): (SourceInfo & { path: string })[] {
  const rows = db
    .prepare(
      `SELECT s.id AS sectionId, s.chapter, s.number, s.title, s.page, s.path, b.title AS book
       FROM concept_sources cs JOIN sections s ON s.id = cs.section_id JOIN books b ON b.id = s.book_id
       WHERE cs.concept_id = ? ORDER BY b.id, s.chapter, s.number LIMIT ?`,
    )
    .all(conceptId, MAX_SECTIONS) as { sectionId: number; chapter: number; number: number; title: string; page: string | null; path: string; book: string }[];
  return rows.map((row) => ({
    sectionId: row.sectionId,
    ref: `${row.chapter}.${row.number}`,
    title: row.title,
    book: row.book,
    page: row.page,
    path: row.path,
  }));
}

function toSources(dataDir: string, sources: (SourceInfo & { path: string })[]): Source[] {
  return sources.map((source) => ({
    id: String(source.sectionId),
    title: `${source.book}, ${source.ref} ${source.title}${source.page ? `, page ${source.page}` : ""}`,
    text: readSection(dataDir, source.path),
  }));
}

function toReferences(references: Reference[], sources: SourceInfo[]): LessonReference[] {
  return references.flatMap((reference) => {
    const source = sources.find((item) => String(item.sectionId) === reference.sourceId);
    return source ? [{ ...source, number: reference.number, quote: reference.quote }] : [];
  });
}

function missingPrerequisites(db: Db, concept: ConceptRow): LessonView["missingPrerequisites"] {
  const rows = db
    .prepare(
      `SELECT c.id AS conceptId, c.slug, c.name, c.status, c.queue_pos FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id
       WHERE p.concept_id = ? ORDER BY c.id`,
    )
    .all(concept.id) as { conceptId: number; slug: string; name: string; status: Status; queue_pos: number | null }[];
  return rows
    .filter((row) => !READY.includes(row.status))
    .map((row) => ({ conceptId: row.conceptId, slug: row.slug, name: row.name, status: row.status, position: row.queue_pos }));
}

// The opening request of the lesson. The latest wrong answers of the diagnosis and the tests help the model to address the mistakes.
function lessonRequest(db: Db, concept: ConceptRow, round: number): string {
  const wrong = db
    .prepare(
      `SELECT q.text, q.kind, q.choices, a.answer, a.feedback FROM questions q JOIN attempts a ON a.question_id = q.id
       WHERE q.concept_id = ? AND a.score < 2 AND a.disputed = 0 ORDER BY a.id DESC LIMIT 4`,
    )
    .all(concept.id) as { text: string; kind: string; choices: string | null; answer: string; feedback: string }[];
  const lines = [`Teach this concept: ${concept.name}`, `Objective: ${concept.objective}`];
  if (wrong.length > 0) {
    lines.push("", "The learner answered these questions wrong. Address these mistakes in the lesson:");
    for (const item of wrong) {
      const answer = item.kind === "choice" ? ((JSON.parse(item.choices ?? "[]") as string[])[Number(item.answer)] ?? item.answer) : item.answer;
      lines.push(`- Question: ${item.text}`, `  Answer of the learner: ${answer}`);
    }
  }
  if (round > 1) {
    lines.push("", "The learner had a lesson about this concept before. Teach it again from a different angle, with different examples.");
  }
  return lines.join("\n");
}

interface LessonRow {
  id: number;
  round: number;
  text: string;
  refs: string;
  created_at: string;
}

export function lessonView(db: Db, conceptId: number): LessonView {
  const concept = conceptRow(db, conceptId);
  const sources = sourcesOf(db, conceptId);
  const lesson = db
    .prepare(
      "SELECT id, round, text, refs, created_at FROM lessons WHERE concept_id = ? ORDER BY round DESC, id DESC LIMIT 1",
    )
    .get(conceptId) as LessonRow | undefined;
  const messages = lesson
    ? (db.prepare("SELECT id, role, text, refs FROM lesson_messages WHERE lesson_id = ? ORDER BY id").all(lesson.id) as {
        id: number;
        role: "user" | "assistant";
        text: string;
        refs: string;
      }[])
    : [];
  const missing = missingPrerequisites(db, concept);
  const names = missing.map((item) => item.name).join(", ");
  return {
    concept: {
      id: concept.id,
      slug: concept.slug,
      name: concept.name,
      objective: concept.objective,
      kind: concept.kind,
      level: concept.level,
      status: concept.status,
      starred: concept.starred === 1,
      theme: { slug: concept.theme_slug, name: concept.theme_name },
      module: { id: concept.module_id, position: concept.module_position, name: concept.module_name },
    },
    lesson: lesson
      ? {
          id: lesson.id,
          round: lesson.round,
          text: lesson.text,
          references: JSON.parse(lesson.refs) as LessonReference[],
          createdAt: lesson.created_at,
        }
      : null,
    messages: messages.map((message): LessonMessage => ({
      id: message.id,
      role: message.role,
      text: message.text,
      references: JSON.parse(message.refs) as LessonReference[],
    })),
    sources: sources.map(({ path: _path, ...source }) => source),
    missingPrerequisites: missing,
    warning: missing.length > 0 ? `This concept needs ${names}, which you do not know yet.` : null,
    queuePosition: concept.queue_pos,
    next: nextInQueue(db, concept),
    openTestId: openTest(db, conceptId),
    hasFinishedTest: lastTest(db, conceptId) !== null,
    failedTests: failedTests(db, conceptId),
  };
}

// The latest test after a lesson that the learner did not finish, or null.
function openTest(db: Db, conceptId: number): number | null {
  return (
    (db
      .prepare(
        `SELECT s.id FROM sessions s JOIN session_concepts sc ON sc.session_id = s.id
         WHERE s.kind = 'test' AND s.status <> 'finished' AND sc.concept_id = ? ORDER BY s.id DESC LIMIT 1`,
      )
      .pluck()
      .get(conceptId) as number | undefined) ?? null
  );
}

// The last finished test of the concept, or null.
function lastTest(db: Db, conceptId: number): number | null {
  return (
    (db
      .prepare(
        `SELECT s.id FROM sessions s JOIN session_concepts sc ON sc.session_id = s.id
         WHERE s.kind = 'test' AND s.status = 'finished' AND sc.concept_id = ? ORDER BY s.id DESC LIMIT 1`,
      )
      .pluck()
      .get(conceptId) as number | undefined) ?? null
  );
}

// Copy the questions of an old test into a new test session, which is then ready with no model call.
// The options of the recall question get a new order, so that the learner cannot remember a position.
function copyQuestions(db: Db, fromSessionId: number, toSessionId: number): void {
  const questions = db
    .prepare("SELECT concept_id, purpose, kind, text, choices, answer, key_points, section_id, position FROM questions WHERE session_id = ? ORDER BY position")
    .all(fromSessionId) as {
    concept_id: number;
    purpose: string;
    kind: string;
    text: string;
    choices: string | null;
    answer: string;
    key_points: string;
    section_id: number | null;
    position: number;
  }[];
  const insert = db.prepare(
    `INSERT INTO questions (concept_id, purpose, kind, text, choices, answer, key_points, section_id, session_id, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const question of questions) {
    let { choices, answer } = question;
    if (question.kind === "choice" && choices) {
      const shuffled = shuffle(JSON.parse(choices) as string[], Number(answer));
      choices = JSON.stringify(shuffled.options);
      answer = String(shuffled.correct);
    }
    insert.run(question.concept_id, question.purpose, question.kind, question.text, choices, answer, question.key_points, question.section_id, toSessionId, question.position);
  }
  db.prepare("UPDATE sessions SET status = 'ready', prepared = total WHERE id = ?").run(toSessionId);
}

// Start the test after a lesson. An unfinished test is used again.
// With again, the test uses the questions of the last finished test, for example to test a mastered concept again.
// If the concept has no finished test, or again is false, the model must write new questions: needsQuestions is true.
export function startTest(db: Db, conceptId: number, again = false): { sessionId: number; needsQuestions: boolean } {
  const concept = conceptRow(db, conceptId);
  const lessons = db.prepare("SELECT COUNT(*) FROM lessons WHERE concept_id = ?").pluck().get(conceptId) as number;
  if (lessons === 0) throw new TutorError("Read the lesson first. The test comes after the lesson.", 409);
  const open = openTest(db, conceptId);
  if (open !== null) return { sessionId: open, needsQuestions: false };
  const last = again ? lastTest(db, conceptId) : null;
  return db.transaction(() => {
    const sessionId = createSession(db, concept.theme_id, concept.module_id, [conceptId], "test");
    if (last === null) return { sessionId, needsQuestions: true };
    copyQuestions(db, last, sessionId);
    return { sessionId, needsQuestions: false };
  })();
}

// The learner skips the test after a lesson, for example for a simple concept.
// As after a pass, the concept becomes mastered and leaves the queue.
export function skipTest(db: Db, conceptId: number): LessonView {
  conceptRow(db, conceptId);
  db.prepare("UPDATE concepts SET status = 'mastered', queue_pos = NULL WHERE id = ?").run(conceptId);
  return lessonView(db, conceptId);
}

// The first concept in the study queue of the theme, without the concept of the lesson.
function nextInQueue(db: Db, concept: ConceptRow): LessonView["next"] {
  return (
    (db
      .prepare("SELECT id AS conceptId, name FROM concepts WHERE theme_id = ? AND status IN ('queued', 'learning') AND id <> ? ORDER BY queue_pos, id LIMIT 1")
      .get(concept.theme_id, concept.id) as LessonView["next"] | undefined) ?? null
  );
}

// After a failed test, the learner can keep the concept for later or skip it.
// "Teach it again" needs no call here: it is a new lesson round.
export function afterTest(db: Db, conceptId: number, action: AfterTestAction): void {
  conceptRow(db, conceptId);
  if (action === "later") {
    // The concept goes to the end of the queue.
    db.transaction(() => {
      db.prepare("UPDATE concepts SET queue_pos = NULL WHERE id = ?").run(conceptId);
      enqueue(db, conceptId);
    })();
  } else if (action === "skip") {
    db.prepare("UPDATE concepts SET status = 'skipped', queue_pos = NULL WHERE id = ?").run(conceptId);
  } else {
    throw new TutorError(`"${action}" is not a valid action.`);
  }
}

// After repeated failed tests, a weak prerequisite is a frequent cause. Test all prerequisites of the concept.
export function testPrerequisites(db: Db, conceptId: number): number {
  const concept = conceptRow(db, conceptId);
  const prerequisites = db.prepare("SELECT prereq_id FROM concept_prereqs WHERE concept_id = ? ORDER BY prereq_id").pluck().all(conceptId) as number[];
  if (prerequisites.length === 0) throw new TutorError("This concept has no prerequisites.", 409);
  return db.transaction(() => {
    for (const id of prerequisites) db.prepare("UPDATE concepts SET status = 'to_test', queue_pos = NULL WHERE id = ?").run(id);
    return createSession(db, concept.theme_id, null, prerequisites, "diagnose");
  })();
}

// The concept in the lesson has the status "learning". Only one concept of a theme can have it.
function markLearning(db: Db, concept: ConceptRow): void {
  db.prepare("UPDATE concepts SET status = 'queued' WHERE theme_id = ? AND status = 'learning' AND id <> ?").run(concept.theme_id, concept.id);
  if (concept.queue_pos === null) enqueue(db, concept.id);
  db.prepare("UPDATE concepts SET status = 'learning' WHERE id = ?").run(concept.id);
}

// Two requests for the same lesson at the same time get the same result.
const writing = new Map<number, Promise<LessonView>>();

// Start a lesson. An existing lesson is used again, unless again is true: then the tutor writes a new round.
export function startLesson(db: Db, llm: LlmClient | null, dataDir: string, conceptId: number, again = false): Promise<LessonView> {
  const concept = conceptRow(db, conceptId);
  const existing = db.prepare("SELECT MAX(round) FROM lessons WHERE concept_id = ?").pluck().get(conceptId) as number | null;
  if (existing !== null && !again) {
    markLearning(db, concept);
    return Promise.resolve(lessonView(db, conceptId));
  }
  if (!llm) throw new TutorError("No model is set. Set the model in .env and start the tutor again.", 503);
  const running = writing.get(conceptId);
  if (running) return running;

  const job = (async () => {
    const sources = sourcesOf(db, conceptId);
    if (sources.length === 0) throw new TutorError("The concept has no book sections to teach from.", 409);
    const round = (existing ?? 0) + 1;
    const result = await llm.text({
      system: LESSON_SYSTEM,
      sources: toSources(dataDir, sources),
      messages: [{ role: "user", content: lessonRequest(db, concept, round) }],
    });
    if (result.text.trim() === "") throw new TutorError("The model returned an empty lesson. Try again.", 502);
    db.transaction(() => {
      db.prepare("INSERT INTO lessons (concept_id, round, text, refs) VALUES (?, ?, ?, ?)").run(
        conceptId,
        round,
        result.text,
        JSON.stringify(toReferences(result.references, sources)),
      );
      markLearning(db, conceptRow(db, conceptId));
    })();
    return lessonView(db, conceptId);
  })().finally(() => writing.delete(conceptId));
  writing.set(conceptId, job);
  return job;
}

interface StoredLesson {
  id: number;
  concept_id: number;
  round: number;
  text: string;
}

function storedLesson(db: Db, lessonId: number): StoredLesson {
  const lesson = db.prepare("SELECT id, concept_id, round, text FROM lessons WHERE id = ?").get(lessonId) as StoredLesson | undefined;
  if (!lesson) throw new TutorError(`The lesson ${lessonId} does not exist.`, 404);
  return lesson;
}

// Answer a question of the learner about a lesson. The conversation starts with the lesson request and the lesson.
export async function askAboutLesson(db: Db, llm: LlmClient | null, dataDir: string, lessonId: number, question: string): Promise<LessonView> {
  if (!llm) throw new TutorError("No model is set. Set the model in .env and start the tutor again.", 503);
  if (question.trim() === "") throw new TutorError("The question is empty.");
  const lesson = storedLesson(db, lessonId);
  const concept = conceptRow(db, lesson.concept_id);
  const sources = sourcesOf(db, lesson.concept_id);
  const history = db.prepare("SELECT role, text FROM lesson_messages WHERE lesson_id = ? ORDER BY id").all(lessonId) as {
    role: "user" | "assistant";
    text: string;
  }[];
  const messages: Message[] = [
    { role: "user", content: lessonRequest(db, concept, lesson.round) },
    { role: "assistant", content: lesson.text },
    ...history.map((message) => ({ role: message.role, content: message.text })),
    { role: "user", content: question.trim() },
  ];
  const result = await llm.text({ system: CHAT_SYSTEM, sources: toSources(dataDir, sources), messages });
  if (result.text.trim() === "") throw new TutorError("The model returned an empty answer. Try again.", 502);
  const insert = db.prepare("INSERT INTO lesson_messages (lesson_id, role, text, refs) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    insert.run(lessonId, "user", question.trim(), "[]");
    insert.run(lessonId, "assistant", result.text, JSON.stringify(toReferences(result.references, sources)));
  })();
  return lessonView(db, lesson.concept_id);
}

// Put a concept at the top of the study queue. A concept that is not in the queue goes into it.
export function moveToTop(db: Db, conceptId: number): void {
  const concept = conceptRow(db, conceptId);
  db.transaction(() => {
    if (concept.queue_pos === null) enqueue(db, conceptId);
    const ids = db
      .prepare("SELECT id FROM concepts WHERE theme_id = ? AND status IN ('queued', 'learning') ORDER BY queue_pos, id")
      .pluck()
      .all(concept.theme_id) as number[];
    const order = [conceptId, ...ids.filter((id) => id !== conceptId)];
    const update = db.prepare("UPDATE concepts SET queue_pos = ? WHERE id = ?");
    order.forEach((id, i) => update.run(i + 1, id));
  })();
}

// Add or remove the star of an important concept. The star does not change the status or the queue.
export function starConcept(db: Db, conceptId: number, starred: unknown): { starred: boolean } {
  conceptRow(db, conceptId);
  if (typeof starred !== "boolean") throw new TutorError('"starred" must be true or false.');
  db.prepare("UPDATE concepts SET starred = ? WHERE id = ?").run(starred ? 1 : 0, conceptId);
  return { starred };
}

// Test one concept, for example a prerequisite: a diagnosis session with this concept only.
export function testConcept(db: Db, conceptId: number): number {
  const { theme_slug: themeSlug } = conceptRow(db, conceptId);
  const result = applyMarks(db, themeSlug, { [conceptId]: "test" });
  return result.sessionId!;
}

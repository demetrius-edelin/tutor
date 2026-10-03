import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../db/index.js";
import type { LlmClient } from "../llm/index.js";
import {
  answerQuestion,
  applyChoices,
  applyMarks,
  disputeAttempt,
  failInterruptedSessions,
  finishSession,
  prepareSession,
  retakeQuestion,
  sessionView,
  TutorError,
} from "../tutor/diagnosis.js";
import {
  afterTest,
  askAboutLesson,
  detailLesson,
  lessonView,
  moveToTop,
  skipTest,
  startLesson,
  startTest,
  testConcept,
  testPrerequisites,
} from "../tutor/lesson.js";
import { applySuggestedOrder, queueView, removeFromQueue, reorderQueue } from "../tutor/queue.js";
import type { AfterTestAction, Choice, Mark } from "./api-types.js";
import { conceptMap, listThemes, section, themeDetail } from "./queries.js";

export interface ServerOptions {
  db: Db;
  dataDir: string;
  // The folder of the built browser app. The server does not serve the app if the folder does not exist.
  appDir?: string;
  // The model client, or null if .env selects no model. Then llmError tells why.
  llm?: LlmClient | null;
  llmError?: string;
}

export interface TutorServer extends FastifyInstance {
  // Wait for the background work, for example the questions of a session. The tests use it.
  idle(): Promise<void>;
}

export function buildServer({ db, dataDir, appDir, llm = null, llmError }: ServerOptions): TutorServer {
  const app = Fastify({ logger: false }) as unknown as TutorServer;
  const jobs = new Set<Promise<void>>();
  failInterruptedSessions(db);
  const runInBackground = (job: Promise<void>) => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  app.decorate("idle", async () => {
    while (jobs.size > 0) await Promise.all([...jobs]);
  });
  const requireModel = (): LlmClient => {
    if (!llm) throw new TutorError(llmError ?? "No model is set. Set the model in .env and start the tutor again.", 503);
    return llm;
  };

  // Errors of the tutor go to the app as { error } with their status code.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TutorError) return reply.code(error.status).send({ error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: message });
  });

  app.get("/api/themes", async () => listThemes(db));

  app.get<{ Params: { slug: string } }>("/api/themes/:slug", async (request, reply) => {
    const theme = themeDetail(db, request.params.slug);
    return theme ?? reply.code(404).send({ error: `The theme "${request.params.slug}" does not exist.` });
  });

  app.get<{ Params: { slug: string } }>("/api/themes/:slug/map", async (request, reply) => {
    const map = conceptMap(db, request.params.slug);
    return map ?? reply.code(404).send({ error: `The theme "${request.params.slug}" does not exist.` });
  });

  app.get<{ Params: { id: string } }>("/api/sections/:id", async (request, reply) => {
    const found = section(db, dataDir, Number(request.params.id));
    return found ?? reply.code(404).send({ error: `The section ${request.params.id} does not exist.` });
  });

  // Diagnosis

  app.post<{ Params: { id: string }; Body: { marks: Record<string, Mark> } }>("/api/modules/:id/selection", async (request) => {
    const marks = request.body?.marks ?? {};
    if (Object.values(marks).includes("test")) requireModel();
    const result = applyMarks(db, Number(request.params.id), marks);
    if (result.sessionId !== null) runInBackground(prepareSession(db, requireModel(), dataDir, result.sessionId));
    return result;
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request) => sessionView(db, Number(request.params.id)));

  // Write the questions again, for example after an error of the model.
  app.post<{ Params: { id: string } }>("/api/sessions/:id/prepare", async (request) => {
    const id = Number(request.params.id);
    const session = sessionView(db, id);
    if (session.status !== "failed") throw new TutorError("Only a failed session can start again.", 409);
    db.prepare("UPDATE sessions SET status = 'preparing', error = NULL, prepared = 0 WHERE id = ?").run(id);
    runInBackground(prepareSession(db, requireModel(), dataDir, id));
    return sessionView(db, id);
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/api/questions/:id/answer", async (request) =>
    answerQuestion(db, llm, dataDir, Number(request.params.id), String(request.body?.answer ?? "")),
  );

  app.post<{ Params: { id: string } }>("/api/attempts/:id/dispute", async (request) => disputeAttempt(db, Number(request.params.id)));

  // Retake a question: its answers go, and the question is open again.
  app.post<{ Params: { id: string } }>("/api/questions/:id/retake", async (request) => {
    retakeQuestion(db, Number(request.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/finish", async (request) => finishSession(db, Number(request.params.id)));

  app.post<{ Params: { id: string }; Body: { choices: Record<string, Choice> } }>("/api/sessions/:id/choices", async (request) =>
    applyChoices(db, Number(request.params.id), request.body?.choices ?? {}),
  );

  // Study queue

  app.get<{ Params: { slug: string } }>("/api/themes/:slug/queue", async (request) => queueView(db, request.params.slug));

  app.post<{ Params: { slug: string }; Body: { conceptIds: number[] } }>("/api/themes/:slug/queue/order", async (request) =>
    reorderQueue(db, request.params.slug, (request.body?.conceptIds ?? []).map(Number)),
  );

  app.post<{ Params: { slug: string } }>("/api/themes/:slug/queue/suggested", async (request) => applySuggestedOrder(db, request.params.slug));

  app.post<{ Params: { slug: string }; Body: { conceptId: number; status: "skipped" | "new" } }>("/api/themes/:slug/queue/remove", async (request) =>
    removeFromQueue(db, request.params.slug, Number(request.body?.conceptId), request.body?.status),
  );

  // Lessons

  app.get<{ Params: { id: string } }>("/api/concepts/:id/lesson", async (request) => lessonView(db, Number(request.params.id)));

  // Start the lesson. With again, the tutor writes a new lesson round.
  app.post<{ Params: { id: string }; Body: { again?: boolean } }>("/api/concepts/:id/lesson", async (request) =>
    startLesson(db, llm, dataDir, Number(request.params.id), Boolean(request.body?.again)),
  );

  // Write the detailed lesson, with references to the books.
  app.post<{ Params: { id: string } }>("/api/lessons/:id/detail", async (request) => detailLesson(db, llm, dataDir, Number(request.params.id)));

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/lessons/:id/messages", async (request) =>
    askAboutLesson(db, llm, dataDir, Number(request.params.id), String(request.body?.text ?? "")),
  );

  // Put a concept at the top of the study queue, for example a prerequisite or a concept to start now.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/top", async (request) => {
    moveToTop(db, Number(request.params.id));
    return { ok: true };
  });

  // Test one concept, for example a prerequisite.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/test", async (request) => {
    const model = requireModel();
    const sessionId = testConcept(db, Number(request.params.id));
    runInBackground(prepareSession(db, model, dataDir, sessionId));
    return { sessionId };
  });

  // The test after a lesson

  app.post<{ Params: { id: string } }>("/api/concepts/:id/check", async (request) => {
    const model = requireModel();
    const result = startTest(db, Number(request.params.id));
    if (result.created) runInBackground(prepareSession(db, model, dataDir, result.sessionId));
    return { sessionId: result.sessionId };
  });

  // Skip the test: the concept becomes mastered.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/skip-test", async (request) => skipTest(db, Number(request.params.id)));

  app.post<{ Params: { id: string }; Body: { action: AfterTestAction } }>("/api/concepts/:id/after-test", async (request) => {
    afterTest(db, Number(request.params.id), request.body?.action);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/concepts/:id/test-prerequisites", async (request) => {
    const model = requireModel();
    const sessionId = testPrerequisites(db, Number(request.params.id));
    runInBackground(prepareSession(db, model, dataDir, sessionId));
    return { sessionId };
  });

  if (appDir && existsSync(appDir)) {
    app.register(fastifyStatic, { root: resolve(appDir) });
  }
  return app;
}

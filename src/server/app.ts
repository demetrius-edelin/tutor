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
  finishSession,
  prepareSession,
  sessionView,
  TutorError,
} from "../tutor/diagnosis.js";
import type { Choice, Mark } from "./api-types.js";
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

  app.post<{ Params: { id: string } }>("/api/sessions/:id/finish", async (request) => finishSession(db, Number(request.params.id)));

  app.post<{ Params: { id: string }; Body: { choices: Record<string, Choice> } }>("/api/sessions/:id/choices", async (request) =>
    applyChoices(db, Number(request.params.id), request.body?.choices ?? {}),
  );

  if (appDir && existsSync(appDir)) {
    app.register(fastifyStatic, { root: resolve(appDir) });
  }
  return app;
}

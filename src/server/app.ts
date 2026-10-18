import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../db/index.js";
import { join } from "node:path";
import { createVideoClient, openRouterPrices } from "../ingest/video/client.js";
import { ensureYtDlp, ytDlpRunner, type YtDlpRunner } from "../ingest/video/ytdlp.js";
import { httpFetcher, type Fetcher } from "../ingest/web/http.js";
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
  lessonView,
  moveToTop,
  skipTest,
  starConcept,
  startLesson,
  startTest,
  testConcept,
  testPrerequisites,
} from "../tutor/lesson.js";
import { applyBookOrder, applySuggestedOrder, queueView, removeFromQueue, reorderQueue } from "../tutor/queue.js";
import type { AfterTestAction, Choice, Mark } from "./api-types.js";
import { addBook, addWebBook, bookView, createSubject, MAX_UPLOAD_BYTES } from "./books.js";
import { failInterruptedIngests, findBook, ingestRow, runningIngest, runText, startIngest, toIngestView } from "./ingests.js";
import { findOnlineToc, startFetch, type OnlineAccess } from "./online.js";
import type { VideoAccess } from "./videos.js";
import { conceptMap, deleteSubject, listSubjects, section, subjectDetail } from "./queries.js";
import { checkModel, envValues, loadModels, saveSettings, settingsView } from "./settings.js";

export interface ServerOptions {
  db: Db;
  dataDir: string;
  // The folder of the built browser app. The server does not serve the app if the folder does not exist.
  appDir?: string;
  // The model client, or null if .env selects no model. Then llmError tells why.
  llm?: LlmClient | null;
  llmError?: string;
  // The model in one line, for the book page.
  modelName?: string;
  // The function that gets a web page, and the pause between two requests to a site. The tests use a fake site with no pause.
  fetcher?: Fetcher;
  fetchPauseMs?: number;
  // The video model from .env, and the parts of a video download. The tests use a fake yt-dlp and a fake video model.
  video?: Partial<VideoAccess>;
  // The .env file of the settings page, and the values of the shell. With no settings, the server has no settings routes.
  settings?: {
    envFile: string;
    // A new .env file starts as a copy of this file.
    exampleFile?: string;
    shellEnv: NodeJS.ProcessEnv;
    log?: (line: string) => void;
  };
}

const NO_MODEL = "No model is set. Open the Settings page and select a model.";

export interface TutorServer extends FastifyInstance {
  // Wait for the background work, for example the questions of a session. The tests use it.
  idle(): Promise<void>;
}

export function buildServer(options: ServerOptions): TutorServer {
  const { db, dataDir, appDir, fetcher, fetchPauseMs, video, settings } = options;
  // The settings page can change the model while the server runs.
  let llm = options.llm ?? null;
  let llmError = options.llmError;
  let modelName = options.modelName;
  const app = Fastify({ logger: false }) as unknown as TutorServer;
  // Two requests at the same time use one install or update of yt-dlp.
  let ytDlpReady: Promise<YtDlpRunner> | null = null;
  const online: OnlineAccess = {
    dataDir,
    web: { fetcher: fetcher ?? httpFetcher, pauseMs: fetchPauseMs ?? 1000 },
    video: {
      config: null,
      error: null,
      ytDlp: () =>
        (ytDlpReady ??= ensureYtDlp({ dir: join(dataDir, "bin"), ...(video?.log ? { log: video.log } : {}) })
          .then((program) => ytDlpRunner(program))
          .finally(() => (ytDlpReady = null))),
      client: createVideoClient,
      prices: (model: string) => openRouterPrices(model),
      ...video,
    },
  };
  const jobs = new Set<Promise<void>>();
  // The ingest runs that the user stopped. A run ends before its next step.
  const stops = new Set<number>();
  failInterruptedSessions(db);
  failInterruptedIngests(db);
  const runInBackground = (job: Promise<void>) => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  app.decorate("idle", async () => {
    while (jobs.size > 0) await Promise.all([...jobs]);
  });
  const requireModel = (): LlmClient => {
    if (!llm) throw new TutorError(llmError ?? NO_MODEL, 503);
    return llm;
  };

  // Errors of the tutor go to the app as { error } with their status code.
  // A request error of Fastify keeps its status code, for example 413 for a file that is too large.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof TutorError) return reply.code(error.status).send({ error: error.message });
    const fastifyError = error as { code?: string; statusCode?: number };
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: `The file is too large. The tutor accepts book files of up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500 ? fastifyError.statusCode : 500;
    return reply.code(status).send({ error: message });
  });

  // The browser sends a book file as the body of one request, so the server needs no package for multipart uploads.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.get("/api/subjects", async () => listSubjects(db));

  app.post<{ Body: { name: unknown } }>("/api/subjects", async (request) => createSubject(db, request.body?.name));

  app.get<{ Params: { slug: string } }>("/api/subjects/:slug", async (request, reply) => {
    const subject = subjectDetail(db, request.params.slug);
    return subject ?? reply.code(404).send({ error: `The subject "${request.params.slug}" does not exist.` });
  });

  // Delete a subject with its books, its concepts, the progress of the learner, and its files.
  app.delete<{ Params: { slug: string } }>("/api/subjects/:slug", async (request, reply) => {
    const running = runningIngest(db, request.params.slug);
    if (running) throw new TutorError(`The tutor ${runText(running)} in this subject. Stop the run, or wait for its end.`, 409);
    if (!deleteSubject(db, dataDir, request.params.slug)) {
      return reply.code(404).send({ error: `The subject "${request.params.slug}" does not exist.` });
    }
    return { ok: true };
  });

  app.get<{ Params: { slug: string } }>("/api/subjects/:slug/map", async (request, reply) => {
    const map = conceptMap(db, dataDir, request.params.slug);
    return map ?? reply.code(404).send({ error: `The subject "${request.params.slug}" does not exist.` });
  });

  // Ingest in the app

  // Upload a book file. The query gives the file name, and the body is the file.
  app.post<{ Params: { slug: string }; Querystring: { name?: string }; Body: unknown }>(
    "/api/subjects/:slug/books",
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request) => addBook(db, dataDir, request.params.slug, request.query.name, request.body),
  );

  app.get<{ Params: { slug: string; book: string } }>("/api/subjects/:slug/books/:book", async (request, reply) => {
    const book = findBook(db, dataDir, request.params.slug, request.params.book);
    if (!book) return reply.code(404).send({ error: `The subject "${request.params.slug}" has no book "${request.params.book}".` });
    const model = { name: llm ? (modelName ?? null) : null, error: llm ? null : (llmError ?? NO_MODEL) };
    return bookView(db, dataDir, book, model, (id) => stops.has(id));
  });

  // Start a preview or a save of some chapters of a book.
  app.post<{ Params: { slug: string; book: string }; Body: { mode: unknown; chapters: unknown } }>(
    "/api/subjects/:slug/books/:book/ingest",
    async (request, reply) => {
      const book = findBook(db, dataDir, request.params.slug, request.params.book);
      if (!book) return reply.code(404).send({ error: `The subject "${request.params.slug}" has no book "${request.params.book}".` });
      const { id, job } = startIngest({ db, llm: requireModel(), dataDir, book, mode: request.body?.mode, chapters: request.body?.chapters, stops });
      runInBackground(job);
      return toIngestView(ingestRow(db, id)!, false);
    },
  );

  // Online books

  // Find the table of contents of an online book. For a site with no llms.txt file, this needs one model request.
  // For a YouTube address, yt-dlp reads the facts of the video or of the playlist.
  app.post<{ Body: { url?: unknown; toc?: unknown } }>("/api/fetch/toc", async (request) => findOnlineToc(online, requireModel, request.body ?? {}));

  // Start the download of some chapters of an online book or of the transcripts of videos.
  // If data/web/ has an EPUB file with the same title, the answer gives the file and no run starts.
  app.post<{ Params: { slug: string }; Body: { toc?: unknown; video?: unknown; chapters?: unknown; again?: unknown } }>(
    "/api/subjects/:slug/fetch",
    async (request) => {
      const { view, job } = startFetch({ db, access: online, subjectSlug: request.params.slug, body: request.body ?? {}, stops });
      if (job) runInBackground(job);
      return view;
    },
  );

  // Add an EPUB file from data/web/ as a book, for example the file of an earlier download.
  app.post<{ Params: { slug: string }; Body: { file?: unknown } }>("/api/subjects/:slug/books/web", async (request) =>
    addWebBook(db, dataDir, request.params.slug, request.body?.file),
  );

  app.get<{ Params: { id: string } }>("/api/ingests/:id", async (request, reply) => {
    const row = ingestRow(db, Number(request.params.id));
    return row ? toIngestView(row, stops.has(row.id)) : reply.code(404).send({ error: `The run ${request.params.id} does not exist.` });
  });

  // Stop a run. It ends after the current image, chapter, or merge. A download ends after the current page, image, or video.
  app.post<{ Params: { id: string } }>("/api/ingests/:id/stop", async (request, reply) => {
    const row = ingestRow(db, Number(request.params.id));
    if (!row) return reply.code(404).send({ error: `The run ${request.params.id} does not exist.` });
    if (row.status === "running") stops.add(row.id);
    return toIngestView(row, stops.has(row.id));
  });

  app.get<{ Params: { id: string } }>("/api/sections/:id", async (request, reply) => {
    const found = section(db, dataDir, Number(request.params.id));
    return found ?? reply.code(404).send({ error: `The section ${request.params.id} does not exist.` });
  });

  // Diagnosis

  // The marks of the learner for concepts from any module of the subject.
  app.post<{ Params: { slug: string }; Body: { marks: Record<string, Mark> } }>("/api/subjects/:slug/selection", async (request) => {
    const marks = request.body?.marks ?? {};
    if (Object.values(marks).includes("test")) requireModel();
    const result = applyMarks(db, request.params.slug, marks);
    // An open diagnosis keeps its questions and answers, so only a new session needs questions.
    if (result.sessionId !== null && result.newSession) runInBackground(prepareSession(db, requireModel(), dataDir, result.sessionId));
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

  app.get<{ Params: { slug: string } }>("/api/subjects/:slug/queue", async (request) => queueView(db, request.params.slug));

  app.post<{ Params: { slug: string }; Body: { conceptIds: number[] } }>("/api/subjects/:slug/queue/order", async (request) =>
    reorderQueue(db, request.params.slug, (request.body?.conceptIds ?? []).map(Number)),
  );

  app.post<{ Params: { slug: string } }>("/api/subjects/:slug/queue/suggested", async (request) => applySuggestedOrder(db, request.params.slug));

  // Put the queue in the order of the sections in the books.
  app.post<{ Params: { slug: string } }>("/api/subjects/:slug/queue/book", async (request) => applyBookOrder(db, request.params.slug));

  app.post<{ Params: { slug: string }; Body: { conceptId: number; status: "skipped" | "new" } }>("/api/subjects/:slug/queue/remove", async (request) =>
    removeFromQueue(db, request.params.slug, Number(request.body?.conceptId), request.body?.status),
  );

  // Lessons

  app.get<{ Params: { id: string } }>("/api/concepts/:id/lesson", async (request) => lessonView(db, dataDir, Number(request.params.id)));

  // Start the lesson. With again, the tutor writes a new lesson round.
  app.post<{ Params: { id: string }; Body: { again?: boolean } }>("/api/concepts/:id/lesson", async (request) =>
    startLesson(db, llm, dataDir, Number(request.params.id), Boolean(request.body?.again)),
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/lessons/:id/messages", async (request) =>
    askAboutLesson(db, llm, dataDir, Number(request.params.id), String(request.body?.text ?? "")),
  );

  // Put a concept at the top of the study queue, for example a prerequisite or a concept to start now.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/top", async (request) => {
    moveToTop(db, Number(request.params.id));
    return { ok: true };
  });

  // Add or remove the star of an important concept.
  app.post<{ Params: { id: string }; Body: { starred: unknown } }>("/api/concepts/:id/star", async (request) =>
    starConcept(db, Number(request.params.id), request.body?.starred),
  );

  // Test one concept, for example a prerequisite.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/test", async (request) => {
    const model = requireModel();
    const { sessionId, newSession } = testConcept(db, Number(request.params.id));
    if (newSession) runInBackground(prepareSession(db, model, dataDir, sessionId));
    return { sessionId };
  });

  // The test after a lesson

  // Start the test after a lesson. With again, the test uses the questions of the last finished test.
  // The model is necessary in both cases, because it grades the open answers.
  app.post<{ Params: { id: string }; Body: { again?: boolean } }>("/api/concepts/:id/check", async (request) => {
    const model = requireModel();
    const result = startTest(db, Number(request.params.id), request.body?.again === true);
    if (result.needsQuestions) runInBackground(prepareSession(db, model, dataDir, result.sessionId));
    return { sessionId: result.sessionId };
  });

  // Skip the test: the concept becomes mastered.
  app.post<{ Params: { id: string } }>("/api/concepts/:id/skip-test", async (request) => skipTest(db, dataDir, Number(request.params.id)));

  app.post<{ Params: { id: string }; Body: { action: AfterTestAction } }>("/api/concepts/:id/after-test", async (request) => {
    afterTest(db, Number(request.params.id), request.body?.action);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/concepts/:id/test-prerequisites", async (request) => {
    const model = requireModel();
    const { sessionId, newSession } = testPrerequisites(db, Number(request.params.id));
    if (newSession) runInBackground(prepareSession(db, model, dataDir, sessionId));
    return { sessionId };
  });

  // Settings

  if (settings) {
    const view = () =>
      settingsView(settings.envFile, envValues(settings.envFile, settings.shellEnv), {
        llmError: llm ? null : (llmError ?? NO_MODEL),
        modelName: llm ? (modelName ?? null) : null,
        video: online.video.config,
        videoError: online.video.error,
      });

    // The model values. The answer gives only the end of each API key.
    app.get("/api/settings", async () => view());

    // Write the values into .env. The new model works at once, with no restart of the server.
    // A run that started before the change keeps the old model.
    app.post<{ Body: unknown }>("/api/settings", async (request) => {
      saveSettings(settings.envFile, settings.exampleFile, request.body);
      const models = loadModels(envValues(settings.envFile, settings.shellEnv));
      llm = models.llm;
      llmError = models.llmError ?? undefined;
      modelName = models.modelName ?? undefined;
      online.video.config = models.video;
      online.video.error = models.videoError;
      settings.log?.(models.modelName ? `Model: ${models.modelName}` : `No model: ${models.llmError}`);
      return view();
    });

    // Send one small request to the model.
    app.post("/api/settings/check", async () => checkModel(requireModel()));
  }

  if (appDir && existsSync(appDir)) {
    app.register(fastifyStatic, { root: resolve(appDir) });
  }
  return app;
}

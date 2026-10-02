import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../db/index.js";
import { conceptMap, listThemes, section, themeDetail } from "./queries.js";

export interface ServerOptions {
  db: Db;
  dataDir: string;
  // The folder of the built browser app. The server does not serve the app if the folder does not exist.
  appDir?: string;
}

export function buildServer({ db, dataDir, appDir }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

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

  if (appDir && existsSync(appDir)) {
    app.register(fastifyStatic, { root: resolve(appDir) });
  }
  return app;
}

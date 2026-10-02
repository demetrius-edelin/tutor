import { loadEnvFile, modelConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createClient, type LlmClient } from "../llm/index.js";
import { buildServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDb("data/tutor.db");

// The app works without a model, but the diagnosis and the lessons need one.
loadEnvFile();
let llm: LlmClient | null = null;
let llmError: string | undefined;
try {
  const config = modelConfig();
  llm = createClient(config);
  console.log(`Model: ${config.provider} ${config.model}`);
} catch (error) {
  llmError = error instanceof Error ? error.message : String(error);
  console.log(`No model: ${llmError}`);
}

const app = buildServer({ db, dataDir: "data", appDir: "dist/app", llm, ...(llmError ? { llmError } : {}) });

// The tutor is for one person on one computer, so the server listens only on localhost.
await app.listen({ host: "127.0.0.1", port });
console.log(`\nThe tutor runs at http://localhost:${port}\nPress Ctrl+C to stop it.\n`);

import { describeModel, describeVideoModel, loadEnvFile, modelConfig, videoConfig, type VideoConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createClient, setModelLog, type LlmClient } from "../llm/index.js";
import { buildServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDb("data/tutor.db");

// The app works without a model, but the diagnosis and the lessons need one.
loadEnvFile();
let llm: LlmClient | null = null;
let llmError: string | undefined;
let modelName: string | undefined;
try {
  const config = modelConfig();
  llm = createClient(config);
  setModelLog((line) => console.log(line));
  console.log(`Model: ${describeModel(config)}`);
  modelName = `${describeModel(config)}${config.reasoning ? `, reasoning ${config.reasoning}` : ""}`;
} catch (error) {
  llmError = error instanceof Error ? error.message : String(error);
  console.log(`No model: ${llmError}`);
}

// Only videos need the video model, so the tutor shows it only if .env sets it.
let video: VideoConfig | null = null;
let videoError: string | null = null;
try {
  video = videoConfig();
  console.log(`Video model: ${describeVideoModel(video)}`);
} catch (error) {
  videoError = error instanceof Error ? error.message : String(error);
}

const app = buildServer({
  db,
  dataDir: "data",
  appDir: "dist/app",
  llm,
  ...(llmError ? { llmError } : {}),
  ...(modelName ? { modelName } : {}),
  video: { config: video, error: videoError, log: (line) => console.log(line) },
});

// The tutor is for one person on one computer, so the server listens only on localhost.
await app.listen({ host: "127.0.0.1", port });
console.log(`\nThe tutor runs at http://localhost:${port}\nPress Ctrl+C to stop it.\n`);

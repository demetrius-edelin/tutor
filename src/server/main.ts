import { describeVideoModel } from "../config.js";
import { openDb } from "../db/index.js";
import { setModelLog } from "../llm/index.js";
import { buildServer } from "./app.js";
import { envValues, loadModels } from "./settings.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDb("data/tutor.db");
const log = (line: string) => console.log(line);

// The settings page writes .env. The server keeps the values of the shell, so it can read the file again after a change.
const ENV_FILE = ".env";
const shellEnv = { ...process.env };

// The app works without a model, but the diagnosis and the lessons need one.
const models = loadModels(envValues(ENV_FILE, shellEnv));
setModelLog(log);
console.log(models.llm ? `Model: ${models.modelName}` : `No model: ${models.llmError}`);
// Only videos need the video model, so the tutor shows it only if .env sets it.
if (models.video) console.log(`Video model: ${describeVideoModel(models.video)}`);

const app = buildServer({
  db,
  dataDir: "data",
  appDir: "dist/app",
  llm: models.llm,
  ...(models.llmError ? { llmError: models.llmError } : {}),
  ...(models.modelName ? { modelName: models.modelName } : {}),
  video: { config: models.video, error: models.videoError, log },
  settings: { envFile: ENV_FILE, exampleFile: ".env.example", shellEnv, log },
});

// The tutor is for one person on one computer, so the server listens only on localhost.
await app.listen({ host: "127.0.0.1", port });
console.log(`\nThe tutor runs at http://localhost:${port}`);
if (!models.llm) console.log(`To select a model, open http://localhost:${port}/#/settings`);
console.log("Press Ctrl+C to stop it.\n");

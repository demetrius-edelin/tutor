import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeVideoModel } from "../config.js";
import { openDb } from "../db/index.js";
import { setModelLog } from "../llm/index.js";
import { buildServer } from "./app.js";
import { FIRST_PORT, freePort, isTranslocated, openBrowser, runningTutor, showError, userDataDir } from "./app-mode.js";
import { envValues, loadModels } from "./settings.js";

// The folder of the program: the repository, or the "app" folder of a download. It has dist/ and .env.example.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Tutor.app and "Start Tutor.bat" start the server with --app. See app-mode.ts.
const appMode = process.argv.includes("--app");
const log = (line: string) => console.log(line);

async function start(): Promise<void> {
  if (appMode) {
    if (process.platform === "darwin" && isTranslocated()) throw new Error("Move Tutor to the Applications folder, then open it again.");
    const first = Number(process.env.PORT ?? FIRST_PORT);
    const running = await runningTutor(first);
    if (running !== null) {
      console.log(`The tutor already runs at http://localhost:${running}`);
      openBrowser(`http://localhost:${running}/`);
      return;
    }
    const home = userDataDir();
    mkdirSync(home, { recursive: true });
    process.chdir(home);
  }

  const db = openDb("data/tutor.db");
  // The settings page writes .env. The server keeps the values of the shell, so it can read the file again after a change.
  const envFile = ".env";
  const shellEnv = { ...process.env };

  // The app works without a model, but the diagnosis and the lessons need one.
  const models = loadModels(envValues(envFile, shellEnv));
  setModelLog(log);
  console.log(models.llm ? `Model: ${models.modelName}` : `No model: ${models.llmError}`);
  // Only videos need the video model, so the tutor shows it only if .env sets it.
  if (models.video) console.log(`Video model: ${describeVideoModel(models.video)}`);

  const app = buildServer({
    db,
    dataDir: "data",
    appDir: join(ROOT, "dist", "app"),
    llm: models.llm,
    ...(models.llmError ? { llmError: models.llmError } : {}),
    ...(models.modelName ? { modelName: models.modelName } : {}),
    video: { config: models.video, error: models.videoError, log },
    settings: { envFile, exampleFile: join(ROOT, ".env.example"), shellEnv, log },
    // The answer of the stop request goes to the browser before the server stops.
    ...(appMode ? { onStop: () => setTimeout(() => process.exit(0), 200) } : {}),
  });

  // The tutor is for one person on one computer, so the server listens only on localhost.
  const port = appMode ? await freePort(Number(process.env.PORT ?? FIRST_PORT)) : Number(process.env.PORT ?? FIRST_PORT);
  await app.listen({ host: "127.0.0.1", port });
  const url = `http://localhost:${port}`;
  console.log(`\nThe tutor runs at ${url}`);
  if (appMode) {
    console.log(`The data is in ${process.cwd()}`);
    openBrowser(models.llm ? `${url}/` : `${url}/#/settings`);
    console.log(process.platform === "win32" ? "To stop the tutor, close this window.\n" : 'To stop the tutor, click "Stop the tutor" on the Settings page.\n');
  } else {
    if (!models.llm) console.log(`To select a model, open ${url}/#/settings`);
    console.log("Press Ctrl+C to stop it.\n");
  }
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (appMode) showError(message);
  else console.error(error);
  process.exit(1);
});

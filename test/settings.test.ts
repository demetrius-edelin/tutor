import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import type { LlmClient } from "../src/llm/index.js";
import type { SettingsView } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { writeEnvValues } from "../src/server/settings.js";

const folder = () => mkdtempSync(join(tmpdir(), "tutor-settings-"));

describe("writeEnvValues", () => {
  it("changes the lines with the same name, and keeps the comments and the other lines", () => {
    const file = join(folder(), ".env");
    writeFileSync(file, "# The provider.\nLLM_PROVIDER=openai\nexport LLM_MODEL = old\nPORT_NOTE=keep\n");
    writeEnvValues(file, { LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-haiku-5-5", LLM_REASONING: "high" });
    expect(readFileSync(file, "utf8")).toBe(
      "# The provider.\nLLM_PROVIDER=anthropic\nLLM_MODEL=claude-haiku-5-5\nPORT_NOTE=keep\nLLM_REASONING=high\n",
    );
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts a new file as a copy of the example file", () => {
    const dir = folder();
    writeFileSync(join(dir, ".env.example"), "# Explanation.\nLLM_PROVIDER=\nLLM_MODEL=");
    writeEnvValues(join(dir, ".env"), { LLM_MODEL: "m", VIDEO_MODEL: "v" }, join(dir, ".env.example"));
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# Explanation.\nLLM_PROVIDER=\nLLM_MODEL=m\nVIDEO_MODEL=v\n");
  });
});

describe("Settings in the app", () => {
  let app: TutorServer;
  let dir: string;
  const logs: string[] = [];

  function start(shellEnv: NodeJS.ProcessEnv = {}, llm: LlmClient | null = null) {
    dir = folder();
    app = buildServer({
      db: openDb(":memory:"),
      dataDir: join(dir, "data"),
      llm,
      ...(llm ? { modelName: "fake model" } : { llmError: "No model is selected." }),
      settings: { envFile: join(dir, ".env"), exampleFile: join(dir, ".env.example"), shellEnv, log: (line) => logs.push(line) },
    });
  }

  const get = async () => (await app.inject({ method: "GET", url: "/api/settings" })).json() as SettingsView;
  const save = (body: unknown) => app.inject({ method: "POST", url: "/api/settings", payload: body as object });
  const values = { provider: "", model: "", reasoning: "", openrouterProviders: "", videoProvider: "", videoModel: "", keys: {} };

  afterEach(async () => {
    await app.close();
    logs.length = 0;
  });

  it("shows the values, and only the end of each key", async () => {
    start({ LLM_PROVIDER: "OpenAI", OPENAI_API_KEY: "sk-proj-1234567890abcd", ANTHROPIC_API_KEY: "short" });
    const view = await get();
    expect(view.values).toMatchObject({ provider: "openai", model: "" });
    expect(view.keys).toEqual({ anthropic: "", openai: "abcd", openrouter: null, google: null });
    expect(JSON.stringify(view)).not.toContain("1234567890");
    expect(view).toMatchObject({ model: null, modelError: "No model is selected.", videoModel: null, videoError: null });
  });

  it("writes .env and uses the new model with no restart", async () => {
    start();
    writeFileSync(join(dir, ".env.example"), "# Explanation.\nLLM_PROVIDER=\n");
    const response = await save({
      ...values,
      provider: "anthropic",
      model: " claude-haiku-5-5 ",
      reasoning: "High",
      keys: { anthropic: "sk-ant-0000000000wxyz", openai: "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      values: { provider: "anthropic", model: "claude-haiku-5-5", reasoning: "high" },
      keys: { anthropic: "wxyz", openai: null },
      model: "anthropic claude-haiku-5-5, reasoning high",
      modelError: null,
    });
    const file = readFileSync(join(dir, ".env"), "utf8");
    expect(file).toContain("# Explanation.\nLLM_PROVIDER=anthropic\n");
    expect(file).toContain("ANTHROPIC_API_KEY=sk-ant-0000000000wxyz\n");
    expect(file).not.toContain("OPENAI_API_KEY");
    expect(logs).toEqual(["Model: anthropic claude-haiku-5-5, reasoning high"]);

    // A save with no key keeps the key in the file.
    await save({ ...values, provider: "anthropic", model: "claude-haiku-5-5" });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-0000000000wxyz\n");
  });

  it("shows the problem of the video model only if a video provider is selected", async () => {
    start();
    let view = (await save({ ...values, videoProvider: "google" })).json() as SettingsView;
    expect(view.videoError).toMatch(/VIDEO_MODEL/);
    view = (await save({ ...values, videoProvider: "openrouter", videoModel: "google/gemini-3.8-flash", keys: { openrouter: "k" } })).json() as SettingsView;
    expect(view).toMatchObject({ videoModel: "openrouter google/gemini-3.8-flash", videoError: null });
    expect(view.modelError).toMatch(/LLM_PROVIDER/);
  });

  it("rejects values that are not valid, and writes nothing", async () => {
    start();
    expect((await save({ ...values, provider: "other" })).json()).toEqual({
      error: 'The provider "other" is not valid. Use anthropic, openai, openrouter, google.',
    });
    expect((await save({ ...values, model: "a model" })).statusCode).toBe(400);
    expect((await save({ ...values, keys: { openai: 'key"#' } })).statusCode).toBe(400);
    expect((await save({ ...values, reasoning: "extreme" })).statusCode).toBe(400);
    expect((await save([])).statusCode).toBe(400);
    expect((await get()).values.provider).toBe("");
  });

  it("joins the OpenRouter providers with commas only", async () => {
    start();
    await save({ ...values, openrouterProviders: " deepinfra/turbo , together,, " });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("OPENROUTER_PROVIDERS=deepinfra/turbo,together\n");
  });

  it("checks the model with one small request", async () => {
    const requests: string[] = [];
    const llm: LlmClient = {
      object: async <T>(request: { prompt: string }) => {
        requests.push(request.prompt);
        return { answer: "OK" } as T;
      },
      text: async () => ({ text: "", references: [] }),
    };
    start({}, llm);
    const response = await app.inject({ method: "POST", url: "/api/settings/check" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seconds: expect.any(Number) });
    expect(requests).toHaveLength(1);
  });

  it("needs a model for the check", async () => {
    start();
    const response = await app.inject({ method: "POST", url: "/api/settings/check" });
    expect(response.statusCode).toBe(503);
  });
});

describe("Server with no settings", () => {
  it("has no settings routes", async () => {
    const app = buildServer({ db: openDb(":memory:"), dataDir: folder() });
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(404);
    await app.close();
  });
});

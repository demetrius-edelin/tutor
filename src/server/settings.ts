import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  describeModel,
  describeVideoModel,
  KEY_NAMES,
  loadEnvFile,
  modelConfig,
  PROVIDERS,
  REASONING_LEVELS,
  VIDEO_PROVIDERS,
  videoConfig,
  type VideoConfig,
} from "../config.js";
import { createClient, type LlmClient } from "../llm/index.js";
import { TutorError } from "../tutor/diagnosis.js";
import type { ModelCheckView, SettingsView } from "./api-types.js";

// The settings page of the app writes the model values into .env, so the user does not edit the file by hand.
// The commands in the terminal read the same file.

// The models of the values. A model that does not work is null, and its error tells why.
export interface Models {
  llm: LlmClient | null;
  llmError: string | null;
  // The model in one line, with the reasoning level.
  modelName: string | null;
  video: VideoConfig | null;
  videoError: string | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The values of the shell, with the values of the .env file on top. See loadEnvFile.
export function envValues(file: string, shellEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...shellEnv };
  loadEnvFile(file, env);
  return env;
}

export function loadModels(env: NodeJS.ProcessEnv): Models {
  const models: Models = { llm: null, llmError: null, modelName: null, video: null, videoError: null };
  try {
    const config = modelConfig(env);
    models.llm = createClient(config);
    models.modelName = `${describeModel(config)}${config.reasoning ? `, reasoning ${config.reasoning}` : ""}`;
  } catch (error) {
    models.llmError = message(error);
  }
  try {
    models.video = videoConfig(env);
  } catch (error) {
    models.videoError = message(error);
  }
  return models;
}

// The settings page shows only the end of a key. A short key shows nothing.
function keyEnd(key: string): string | null {
  if (!key) return null;
  return key.length >= 16 ? key.slice(-4) : "";
}

export function settingsView(file: string, env: NodeJS.ProcessEnv, models: Omit<Models, "llm">): Omit<SettingsView, "canStop"> {
  const value = (name: string) => (env[name] ?? "").trim();
  const videoProvider = value("VIDEO_PROVIDER").toLowerCase();
  return {
    values: {
      provider: value("LLM_PROVIDER").toLowerCase(),
      model: value("LLM_MODEL"),
      reasoning: value("LLM_REASONING").toLowerCase(),
      openrouterProviders: value("OPENROUTER_PROVIDERS"),
      videoProvider,
      videoModel: value("VIDEO_MODEL"),
    },
    keys: Object.fromEntries(PROVIDERS.map((provider) => [provider, keyEnd(value(KEY_NAMES[provider]))])),
    model: models.modelName,
    modelError: models.modelName ? null : models.llmError,
    // The video model is optional, so no video provider is not an error.
    videoModel: models.video ? describeVideoModel(models.video) : null,
    videoError: models.video || !videoProvider ? null : models.videoError,
    file: resolve(file),
  };
}

// Model names and API keys use only these characters. Thus a value needs no quotes in .env.
const SAFE = /^[A-Za-z0-9._:/@+=,-]*$/;
const SAFE_TEXT = "letters, digits, and the characters . _ - / : @ + = ,";

function text(body: Record<string, unknown>, name: string, label: string): string {
  const value = body[name] ?? "";
  if (typeof value !== "string") throw new TutorError(`The ${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > 500) throw new TutorError(`The ${label} is too long.`);
  if (!SAFE.test(trimmed)) throw new TutorError(`The ${label} can contain only ${SAFE_TEXT}.`);
  return trimmed;
}

function choice(body: Record<string, unknown>, name: string, label: string, allowed: readonly string[]): string {
  const value = text(body, name, label).toLowerCase();
  if (value && !allowed.includes(value)) throw new TutorError(`The ${label} "${value}" is not valid. Use ${allowed.join(", ")}.`);
  return value;
}

// Write the values of the settings page into .env. An empty key keeps the key in the file.
// An empty value in .env does not change a value from the shell. See loadEnvFile.
export function saveSettings(file: string, exampleFile: string | undefined, body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TutorError("The settings are missing.");
  const input = body as Record<string, unknown>;
  // "deepinfra, together" becomes "deepinfra,together".
  const list = input.openrouterProviders;
  const providers = typeof list === "string" ? list.split(",").map((slug) => slug.trim()).filter(Boolean).join(",") : list;
  const values: Record<string, string> = {
    LLM_PROVIDER: choice(input, "provider", "provider", PROVIDERS),
    LLM_MODEL: text(input, "model", "model name"),
    LLM_REASONING: choice(input, "reasoning", "reasoning level", REASONING_LEVELS),
    OPENROUTER_PROVIDERS: text({ providers }, "providers", "list of OpenRouter providers"),
    VIDEO_PROVIDER: choice(input, "videoProvider", "video provider", VIDEO_PROVIDERS),
    VIDEO_MODEL: text(input, "videoModel", "video model name"),
  };
  const keys = input.keys ?? {};
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw new TutorError("The API keys must be an object.");
  for (const provider of PROVIDERS) {
    const key = text(keys as Record<string, unknown>, provider, `API key for ${provider}`);
    if (key) values[KEY_NAMES[provider]] = key;
  }
  writeEnvValues(file, values, exampleFile);
}

// Write the values into the .env file. A line with the same name gets the new value. The other lines stay, also the comments.
// A new file starts as a copy of the example file, because the example file explains each value.
export function writeEnvValues(file: string, values: Record<string, string>, exampleFile?: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : exampleFile && existsSync(exampleFile) ? readFileSync(exampleFile, "utf8") : "";
  for (const [name, value] of Object.entries(values)) {
    const line = `^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`;
    if (new RegExp(line, "m").test(content)) {
      content = content.replace(new RegExp(line, "gm"), () => `${name}=${value}`);
    } else {
      content += `${content === "" || content.endsWith("\n") ? "" : "\n"}${name}=${value}\n`;
    }
  }
  // The file has the API keys, so only the user can read it. The tutor writes a new file, then renames it.
  // Thus a failed write keeps the old file.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

// One small request, so that the user knows that the key and the model name work.
export async function checkModel(llm: LlmClient): Promise<ModelCheckView> {
  const start = Date.now();
  await llm.object({
    system: "You check the connection to a model.",
    prompt: "Answer with the word OK.",
    schema: z.object({ answer: z.string() }),
  });
  return { seconds: Math.round((Date.now() - start) / 100) / 10 };
}

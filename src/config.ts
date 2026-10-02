import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const KEY_NAMES: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  // Null means the default of the model.
  reasoning: ReasoningLevel | null;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Read the .env file. A value in .env replaces a value from the shell.
// An empty value in .env does not change the shell value.
export function loadEnvFile(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (value !== undefined && value.trim() !== "") env[name] = value.trim();
  }
}

// The model that the user selected in .env. The tutor has no default model.
export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) {
    throw new ConfigError("No provider is selected. In .env, set LLM_PROVIDER to anthropic, openai, or openrouter.");
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new ConfigError(`LLM_PROVIDER "${provider}" is not valid. Use anthropic, openai, or openrouter.`);
  }
  const model = (env.LLM_MODEL ?? "").trim();
  if (!model) {
    throw new ConfigError("No model is selected. In .env, set LLM_MODEL to a model name of the provider.");
  }
  const keyName = KEY_NAMES[provider as Provider];
  const apiKey = (env[keyName] ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(`The provider "${provider}" needs an API key. In .env, set ${keyName}.`);
  }
  const reasoning = (env.LLM_REASONING ?? "").trim().toLowerCase();
  if (reasoning && !(REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new ConfigError(
      `LLM_REASONING "${reasoning}" is not valid. Use ${REASONING_LEVELS.join(", ")}, or leave it empty for the default of the model.`,
    );
  }
  return { provider: provider as Provider, model, apiKey, reasoning: (reasoning || null) as ReasoningLevel | null };
}

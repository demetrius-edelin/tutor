import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadEnvFile, modelConfig } from "../src/config.js";

describe("modelConfig", () => {
  it("reads the provider, the model, and the key of the provider", () => {
    const config = modelConfig({ LLM_PROVIDER: "OpenRouter", LLM_MODEL: "vendor/model", OPENROUTER_API_KEY: "key-1" });
    expect(config).toEqual({ provider: "openrouter", model: "vendor/model", apiKey: "key-1", reasoning: null });
  });

  it("reads the reasoning level, and rejects an unknown level", () => {
    const base = { LLM_PROVIDER: "openai", LLM_MODEL: "m", OPENAI_API_KEY: "k" };
    expect(modelConfig({ ...base, LLM_REASONING: "High" }).reasoning).toBe("high");
    expect(() => modelConfig({ ...base, LLM_REASONING: "extreme" })).toThrow(/LLM_REASONING/);
  });

  it("has no default model", () => {
    expect(() => modelConfig({})).toThrow(ConfigError);
    expect(() => modelConfig({ LLM_PROVIDER: "openai" })).toThrow(/LLM_MODEL/);
  });

  it("rejects an unknown provider", () => {
    expect(() => modelConfig({ LLM_PROVIDER: "other", LLM_MODEL: "x" })).toThrow(/not valid/);
  });

  it("needs the key of the selected provider", () => {
    expect(() => modelConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: "x", OPENAI_API_KEY: "key" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe("loadEnvFile", () => {
  it("replaces shell values with values from the file, and ignores empty values", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tutor-")), ".env");
    writeFileSync(file, "LLM_PROVIDER=openai\nOPENAI_API_KEY=from-file\nANTHROPIC_API_KEY=\n");
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "from-shell", ANTHROPIC_API_KEY: "shell-key" };
    loadEnvFile(file, env);
    expect(env).toEqual({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "from-file", ANTHROPIC_API_KEY: "shell-key" });
  });

  it("does nothing if the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile("/no/such/file/.env", env);
    expect(env).toEqual({});
  });
});

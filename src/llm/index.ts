import type { ModelConfig } from "../config.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAiClient } from "./openai.js";
import type { LlmClient } from "./types.js";

export * from "./types.js";
export { setModelLog } from "./log.js";

// Make the client for the provider that the user selected in .env.
export function createClient(config: ModelConfig): LlmClient {
  return config.provider === "anthropic" ? new AnthropicClient(config) : new OpenAiClient(config);
}

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ModelConfig } from "../config.js";
import { LlmError } from "./types.js";

// Change an SDK error into an error with a clear message. The SDKs already retry
// rate limits, server errors, and connection errors two times.
export function toLlmError(error: unknown, config: ModelConfig): Error {
  if (error instanceof LlmError) return error;
  const where = `${config.provider} (model "${config.model}")`;
  const is = (...classes: Array<abstract new (...args: never[]) => unknown>) =>
    classes.some((errorClass) => error instanceof errorClass);

  if (is(Anthropic.AuthenticationError, OpenAI.AuthenticationError)) {
    return new LlmError(`${where} did not accept the API key. Check the key in .env.`);
  }
  if (is(Anthropic.PermissionDeniedError, OpenAI.PermissionDeniedError)) {
    return new LlmError(`${where}: the API key has no access to this model.`);
  }
  if (is(Anthropic.NotFoundError, OpenAI.NotFoundError)) {
    return new LlmError(`${where}: the model was not found. Check LLM_MODEL in .env.`);
  }
  if (is(Anthropic.RateLimitError, OpenAI.RateLimitError)) {
    return new LlmError(`${where}: the rate limit or the credit limit is reached. Try again later.`);
  }
  if (is(Anthropic.BadRequestError, OpenAI.BadRequestError)) {
    return new LlmError(`${where} rejected the request: ${(error as Error).message}`);
  }
  if (is(Anthropic.APIConnectionError, OpenAI.APIConnectionError)) {
    return new LlmError(`Cannot connect to ${config.provider}. Check the network connection.`);
  }
  if (is(Anthropic.APIError, OpenAI.APIError)) {
    return new LlmError(`${where} returned an error: ${(error as Error).message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

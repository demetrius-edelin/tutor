import OpenAI from "openai";
import { z } from "zod";
import type { ModelConfig } from "../config.js";
import { toLlmError } from "./errors.js";
import { logModelCall } from "./log.js";
import { formatSources, jsonInstructions, readJson, REFERENCE_INSTRUCTIONS } from "./prompt.js";
import { checkReferences, ReferenceList } from "./references.js";
import { LlmError, type LlmClient, type ObjectRequest, type TextRequest, type TextResult } from "./types.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

type Sdk = Pick<OpenAI, "chat">;
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// The options for the OpenAI SDK. OpenRouter uses the same API at a different URL.
export function openAiOptions(config: ModelConfig): ConstructorParameters<typeof OpenAI>[0] {
  if (config.provider === "openrouter") {
    return { apiKey: config.apiKey, baseURL: OPENROUTER_URL, defaultHeaders: { "X-Title": "Engineering Skills Tutor" } };
  }
  return { apiKey: config.apiKey };
}

// A JSON schema for strict structured outputs: no "$schema" key, each object property is required,
// and no object accepts more properties.
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== "$schema") result[key] = visit(value);
    }
    if (result.type === "object" && result.properties && typeof result.properties === "object") {
      result.required = Object.keys(result.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return visit(z.toJSONSchema(schema)) as Record<string, unknown>;
}

// The reasoning level. OpenRouter takes it in its own format: a "reasoning" object with "effort".
export function reasoningParams(config: ModelConfig): Record<string, unknown> {
  if (!config.reasoning) return {};
  return config.provider === "openrouter" ? { reasoning: { effort: config.reasoning } } : { reasoning_effort: config.reasoning };
}

// The providers of OpenRouter that can serve the model, in order. No other provider gets the request.
export function routingParams(config: ModelConfig): Record<string, unknown> {
  if (config.provider !== "openrouter" || !config.providers?.length) return {};
  return { provider: { order: config.providers, allow_fallbacks: false } };
}

// Facts about an answer for an error message: the finish reason, the tokens, and the provider behind OpenRouter.
function answerDetails(response: OpenAI.Chat.Completions.ChatCompletion): string {
  const choice = response.choices[0];
  const reasoning = (choice?.message as { reasoning?: string | null } | undefined)?.reasoning;
  const parts = [`finish reason "${choice?.finish_reason ?? "none"}"`];
  if (response.usage) {
    const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens ?? 0;
    parts.push(`${response.usage.completion_tokens} output tokens, ${reasoningTokens} of them for reasoning`);
  }
  if (reasoning?.trim()) parts.push("text only in the reasoning field");
  const provider = (response as { provider?: string }).provider;
  if (provider) parts.push(`provider ${provider}`);
  return parts.join(", ");
}

// A 400 error about the response format means that the model does not accept a JSON schema.
function isSchemaUnsupported(error: unknown): boolean {
  return error instanceof OpenAI.BadRequestError && /response_format|json_schema|structured output/i.test(error.message);
}

export class OpenAiClient implements LlmClient {
  private readonly sdk: Sdk;
  // Set to false after the model rejects a JSON schema. Then the prompt asks for JSON.
  private schemaSupported = true;

  constructor(
    private readonly config: ModelConfig,
    sdk?: Sdk,
  ) {
    this.sdk = sdk ?? new OpenAI(openAiOptions(config));
  }

  // Some reasoning models on OpenRouter sometimes return an empty answer with a normal finish,
  // and put the text in the reasoning field. Then the client asks one more time.
  private async complete(
    messages: ChatMessage[],
    responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"],
  ): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      let response: OpenAI.Chat.Completions.ChatCompletion;
      const start = Date.now();
      try {
        response = await this.sdk.chat.completions.create({
          model: this.config.model,
          messages,
          ...reasoningParams(this.config),
          ...routingParams(this.config),
          ...(responseFormat ? { response_format: responseFormat } : {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      } catch (error) {
        logModelCall(start, `failed: ${error instanceof Error ? error.message : String(error)}`);
        if (responseFormat && isSchemaUnsupported(error)) throw error;
        throw toLlmError(error, this.config);
      }
      logModelCall(start, `${answerDetails(response)}${response.choices[0]?.message.content?.trim() ? "" : ", empty answer"}`);
      const choice = response.choices[0];
      if (!choice) throw new LlmError("The model returned no answer.");
      if (choice.message.refusal) throw new LlmError(`The model refused the request: ${choice.message.refusal}`);
      if (choice.finish_reason === "length") {
        throw new LlmError(
          `The answer of the model stopped before the end (${answerDetails(response)}). If most tokens are for reasoning, set a lower LLM_REASONING.`,
        );
      }
      if (choice.finish_reason === "content_filter") throw new LlmError("The content filter of the provider stopped the answer.");
      const content = choice.message.content ?? "";
      if (content.trim() !== "") return content;
      if (attempt === 2) {
        throw new LlmError(
          `The model returned an empty answer two times (${answerDetails(response)}). Try again. If the problem continues, set a lower LLM_REASONING or select a different model.`,
        );
      }
    }
  }

  async object<T>(request: ObjectRequest<T>): Promise<T> {
    const schema = strictJsonSchema(request.schema);
    const prompt = request.sources?.length ? `${formatSources(request.sources)}\n\n${request.prompt}` : request.prompt;
    const messages: ChatMessage[] = [
      { role: "system", content: request.system },
      { role: "user", content: this.schemaSupported ? prompt : `${prompt}\n\n${jsonInstructions(schema)}` },
    ];

    for (let attempt = 1; attempt <= 2; attempt++) {
      let text: string;
      try {
        text = await this.complete(
          messages,
          this.schemaSupported ? { type: "json_schema", json_schema: { name: "result", strict: true, schema } } : undefined,
        );
      } catch (error) {
        if (!isSchemaUnsupported(error)) throw error;
        this.schemaSupported = false;
        messages[1] = { role: "user", content: `${prompt}\n\n${jsonInstructions(schema)}` };
        text = await this.complete(messages);
      }
      let value: unknown;
      try {
        value = readJson(text);
      } catch {
        value = undefined;
      }
      const result = request.schema.safeParse(value);
      if (result.success) return result.data;
      const problem = value === undefined ? "The answer is not valid JSON." : `The JSON does not match the schema: ${result.error.message}.`;
      messages.push({ role: "assistant", content: text || "(no text)" }, { role: "user", content: `${problem} Answer again with valid JSON.` });
    }
    throw new LlmError("The model did not return JSON that matches the schema.");
  }

  async text(request: TextRequest): Promise<TextResult> {
    const [first, ...rest] = request.messages;
    if (!first || first.role !== "user") throw new Error("The first message must come from the user.");

    // The sources come first in the first message, in the same order for each call,
    // so that the provider can cache them.
    const ids = request.sources.map((_, i) => `S${i + 1}`);
    const sources = request.sources.length > 0 ? `${formatSources(request.sources, ids)}\n\n` : "";
    const cite = request.sources.length > 0 && request.cite !== false;
    const messages: ChatMessage[] = [
      { role: "system", content: cite ? `${request.system}\n\n${REFERENCE_INSTRUCTIONS}` : request.system },
      { role: "user", content: `${sources}${first.content}` },
      ...rest.map((message): ChatMessage => ({ role: message.role, content: message.content })),
    ];
    const answer = await this.complete(messages);

    // Change each marker [S2: "quote"] into a reference number.
    const references = new ReferenceList();
    const text = answer.replace(/\s*\[(S\d+)\s*:\s*["“]([\s\S]+?)["”]\s*\]/g, (marker, id: string, quote: string) => {
      const source = request.sources[ids.indexOf(id)];
      return source ? ` [${references.add(source.id, quote)}]` : "";
    });
    return checkReferences(text.trim(), references.list(), request.sources);
  }
}

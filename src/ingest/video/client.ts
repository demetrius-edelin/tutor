import OpenAI from "openai";
import type { VideoConfig } from "../../config.js";
import { OPENROUTER_URL } from "../../llm/openai.js";
import { LlmError } from "../../llm/types.js";

// The video model: a Gemini model that reads a YouTube video from its address, through OpenRouter or through the
// Gemini API of Google. The tutor does not download the video.

export interface TranscribeRequest {
  // The YouTube address of the video.
  url: string;
  prompt: string;
  maxTokens: number;
}

export interface TranscribeResult {
  text: string;
  // "stop" for a full answer, "length" for an answer that reached the token limit.
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  // The cost in dollars, if the provider gives it.
  cost: number | null;
}

export interface VideoClient {
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}

// A long video can take some minutes.
const TIMEOUT_MS = 15 * 60 * 1000;

type Sdk = Pick<OpenAI, "chat">;

function openRouterError(error: unknown, config: VideoConfig): Error {
  const where = `openrouter (video model "${config.model}")`;
  if (error instanceof OpenAI.AuthenticationError) return new LlmError(`${where} did not accept the API key. Check OPENROUTER_API_KEY in .env.`);
  if (error instanceof OpenAI.NotFoundError) return new LlmError(`${where}: ${error.message}. Check VIDEO_MODEL in .env.`);
  if (error instanceof OpenAI.RateLimitError) return new LlmError(`${where}: the rate limit or the credit limit is reached. Try again later.`);
  if (error instanceof OpenAI.BadRequestError) return new LlmError(`${where} rejected the request: ${error.message}`);
  if (error instanceof OpenAI.APIConnectionError) return new LlmError("Cannot connect to OpenRouter. Check the network connection.");
  if (error instanceof OpenAI.APIError) return new LlmError(`${where} returned an error: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

// OpenRouter passes a YouTube address in a "video_url" part to Gemini on Google AI Studio.
export class OpenRouterVideoClient implements VideoClient {
  private readonly sdk: Sdk;

  constructor(
    private readonly config: VideoConfig,
    sdk?: Sdk,
  ) {
    // One retry only: a request that the provider finished costs money, also if the answer does not arrive.
    this.sdk = sdk ?? new OpenAI({ apiKey: config.apiKey, baseURL: OPENROUTER_URL, defaultHeaders: { "X-Title": "Tutor" }, timeout: TIMEOUT_MS, maxRetries: 1 });
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.sdk.chat.completions.create({
        model: this.config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: request.prompt },
              { type: "video_url", video_url: { url: request.url, processing: "static" } },
            ],
          },
        ],
        max_tokens: request.maxTokens,
        reasoning: { effort: "low" },
        usage: { include: true },
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    } catch (error) {
      throw openRouterError(error, this.config);
    }
    const choice = response.choices[0];
    if (!choice) throw new LlmError("The video model returned no answer.");
    const usage = response.usage as (OpenAI.CompletionUsage & { cost?: number }) | undefined;
    return {
      text: choice.message.content ?? "",
      finishReason: choice.finish_reason ?? "none",
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cost: typeof usage?.cost === "number" ? usage.cost : null,
    };
  }
}

export const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

interface GeminiInteraction {
  status?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
  error?: { message?: string };
}

function geminiError(status: number, message: string, config: VideoConfig): LlmError {
  const where = `google (video model "${config.model}")`;
  if (status === 401 || (status === 400 && /api key/i.test(message))) return new LlmError(`${where} did not accept the API key. Check GEMINI_API_KEY in .env.`);
  if (status === 403) return new LlmError(`${where}: the API key has no access to this model. ${message}`);
  if (status === 404) return new LlmError(`${where}: the model was not found. Check VIDEO_MODEL in .env. ${message}`);
  if (status === 429) return new LlmError(`${where}: the rate limit or the daily limit is reached. Try again later. ${message}`);
  return new LlmError(`${where} returned an error (HTTP status ${status}): ${message}`);
}

// The Interactions API of Gemini takes the YouTube address in a "video" part.
export class GeminiVideoClient implements VideoClient {
  constructor(
    private readonly config: VideoConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const body = {
      model: this.config.model,
      input: [
        { type: "text", text: request.prompt },
        { type: "video", uri: request.url, processing: "static" },
      ],
      generation_config: { max_output_tokens: request.maxTokens, thinking_level: "low" },
      store: false,
    };
    let response: Response;
    try {
      response = await this.fetcher(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new LlmError(`Cannot connect to the Gemini API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const json = (await response.json().catch(() => null)) as GeminiInteraction | null;
    if (!response.ok) throw geminiError(response.status, json?.error?.message ?? "", this.config);
    if (!json) throw new LlmError("The Gemini API returned no answer.");
    if (json.status !== "completed" && json.status !== "incomplete") {
      throw new LlmError(`The Gemini API returned the status "${json.status ?? "none"}".`);
    }
    const text = (json.steps ?? [])
      .filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    return {
      text,
      // "incomplete" means that the answer reached the token limit.
      finishReason: json.status === "completed" ? "stop" : "length",
      inputTokens: json.usage?.total_input_tokens ?? 0,
      outputTokens: (json.usage?.total_output_tokens ?? 0) + (json.usage?.total_thought_tokens ?? 0),
      cost: null,
    };
  }
}

export function createVideoClient(config: VideoConfig): VideoClient {
  return config.provider === "google" ? new GeminiVideoClient(config) : new OpenRouterVideoClient(config);
}

// Dollars for each token.
export interface ModelPrices {
  input: number;
  output: number;
}

// The prices of a model from the public model list of OpenRouter, or null if the list does not have them.
export async function openRouterPrices(model: string, fetcher: typeof fetch = fetch): Promise<ModelPrices | null> {
  try {
    const response = await fetcher(`${OPENROUTER_URL}/models`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    const list = (await response.json()) as { data?: { id?: string; pricing?: { prompt?: string; completion?: string } }[] };
    const pricing = list.data?.find((item) => item.id === model)?.pricing;
    const input = Number(pricing?.prompt);
    const output = Number(pricing?.completion);
    return Number.isFinite(input) && Number.isFinite(output) && pricing?.prompt && pricing.completion ? { input, output } : null;
  } catch {
    return null;
  }
}

// Gemini counts about 100 input tokens for each second of video in the mode "static".
// The transcript has about 550 output tokens for each minute.
export function estimateCost(seconds: number, prices: ModelPrices): number {
  return seconds * 100 * prices.input + (seconds / 60) * 550 * prices.output;
}

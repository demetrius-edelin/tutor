import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import type { VideoConfig, VideoTier } from "../../config.js";
import { OPENROUTER_URL } from "../../llm/openai.js";
import { LlmError } from "../../llm/types.js";
import { MAX_VIDEO_SECONDS } from "./transcript.js";

// The video model: a Gemini model that reads a YouTube video from its address, through OpenRouter or through the
// Gemini API of Google. The tutor does not download the video.

// A part of a video, in seconds from the start of the video.
export interface Clip {
  start: number;
  end: number;
}

export interface TranscribeRequest {
  // The YouTube address of the video.
  url: string;
  prompt: string;
  maxTokens: number;
  // The tier of the Gemini API. The default is Standard. OpenRouter always uses Standard.
  tier?: VideoTier;
  // The time limit of the request. The default is TIMEOUT_MS.
  timeoutMs?: number;
  // A part of the video. Only the Gemini API accepts a clip.
  clip?: Clip;
}

export interface TranscribeResult {
  text: string;
  // "stop" for a full answer, "length" for an answer that reached the token limit.
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  // The cost in dollars, if the provider gives it.
  cost: number | null;
  // The tier that served the request. The default is Standard.
  tier?: VideoTier;
}

export interface VideoClient {
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
}

// A long video can take some minutes.
const TIMEOUT_MS = 15 * 60 * 1000;

type Sdk = Pick<OpenAI, "chat">;

function openRouterError(error: unknown, config: VideoConfig): Error {
  const where = `openrouter (video model "${config.model}")`;
  if (error instanceof OpenAI.AuthenticationError) return new LlmError(`${where} did not accept the API key. Check the OpenRouter key on the Settings page or in .env.`);
  if (error instanceof OpenAI.NotFoundError) return new LlmError(`${where}: ${error.message}. Check the video model name on the Settings page or in .env.`);
  if (error instanceof OpenAI.RateLimitError) return new LlmError(`${where}: the rate limit or the credit limit is reached. Try again later.`);
  if (error instanceof OpenAI.BadRequestError) return new LlmError(`${where} rejected the request: ${error.message}`);
  if (error instanceof OpenAI.APIConnectionError) return new LlmError("Cannot connect to OpenRouter. Check the network connection.");
  if (error instanceof OpenAI.APIError) return new LlmError(`${where} returned an error: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

// OpenRouter passes a YouTube address in a "video_url" part to Gemini on Google AI Studio. It sends no clip and no
// tier, so a long video needs the Gemini API.
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
    if (request.clip) throw new LlmError("OpenRouter sends no clip offsets to Gemini. Select the video provider Google Gemini API on the Settings page.");
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

// The fetch of Node.js waits at most 5 minutes for the headers of an answer, also with a longer AbortSignal. A Flex
// request can wait longer in the queue of Google, and a long video can take longer. This fetch has no time limits of
// its own, so the AbortSignal of the request is the only limit. Do not change it back to the fetch of Node.js.
const longAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export const longFetch = ((input: string | URL, init?: RequestInit) =>
  undiciFetch(input, { ...init, dispatcher: longAgent } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;

interface GeminiInteraction {
  status?: string;
  service_tier?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number };
  error?: { message?: string };
}

function geminiError(status: number, message: string, config: VideoConfig): LlmError {
  const where = `google (video model "${config.model}")`;
  if (status === 401 || (status === 400 && /api key/i.test(message))) return new LlmError(`${where} did not accept the API key. Check the Gemini key on the Settings page or in .env.`);
  if (status === 403) return new LlmError(`${where}: the API key has no access to this model. ${message}`);
  if (status === 404) return new LlmError(`${where}: the model was not found. Check the video model name on the Settings page or in .env. ${message}`);
  if (status === 429) return new LlmError(`${where}: the rate limit or the daily limit is reached. Try again later. ${message}`);
  if (status === 503) return new LlmError(`${where} has no capacity now. Try again later. ${message}`);
  return new LlmError(`${where} returned an error (HTTP status ${status}): ${message}`);
}

// The Interactions API of Gemini takes the YouTube address in a "video" part. The API refuses the clip offsets as
// numbers, so they are strings, for example "180s".
export class GeminiVideoClient implements VideoClient {
  constructor(
    private readonly config: VideoConfig,
    private readonly fetcher: typeof fetch = longFetch,
  ) {}

  async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
    const clip = request.clip ? { start_offset: `${request.clip.start}s`, end_offset: `${request.clip.end}s` } : {};
    const timeoutMs = request.timeoutMs ?? TIMEOUT_MS;
    const body = {
      model: this.config.model,
      input: [
        { type: "text", text: request.prompt },
        { type: "video", uri: request.url, processing: { type: "static", ...clip } },
      ],
      generation_config: { max_output_tokens: request.maxTokens, thinking_level: "low" },
      store: false,
      // Without a tier, the request uses Standard.
      ...(request.tier === "flex" ? { service_tier: "flex" } : {}),
    };
    let response: Response;
    try {
      response = await this.fetcher(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new LlmError(`The Gemini API gave no answer in ${Math.round(timeoutMs / 60_000)} minutes.`);
      }
      throw new LlmError(`Cannot connect to the Gemini API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const answer = (await response.json().catch(() => null)) as GeminiInteraction | GeminiInteraction[] | null;
    // Google can send an error as an array with one object, for example for a key that is not valid.
    const json = Array.isArray(answer) ? (answer[0] ?? null) : answer;
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
      tier: json.service_tier === "flex" ? "flex" : "standard",
    };
  }
}

export function createVideoClient(config: VideoConfig): VideoClient {
  return config.provider === "google" ? new GeminiVideoClient(config) : new OpenRouterVideoClient(config);
}

// True if the video model takes a long video in clips. Only the Gemini API of Google takes clip offsets.
export function takesClips(config: VideoConfig): boolean {
  return config.provider === "google";
}

// The longest video that the video model can transcribe, or null for no limit.
export function maxVideoSeconds(config: VideoConfig | null): number | null {
  return config && takesClips(config) ? null : MAX_VIDEO_SECONDS;
}

export function tooLong(seconds: number | null, config: VideoConfig | null): boolean {
  const max = maxVideoSeconds(config);
  return seconds !== null && max !== null && seconds > max;
}

// The reason of the limit, for a video that is too long.
export const LIMIT_TEXT = `Through OpenRouter, the tutor transcribes videos of up to ${MAX_VIDEO_SECONDS / 60} minutes, because a longer transcript does not fit into the answer of the model. The Gemini API of Google transcribes a longer video in clips. To use it, select the video provider Google Gemini API on the Settings page.`;

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

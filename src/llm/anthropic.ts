import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ModelConfig } from "../config.js";
import { toLlmError } from "./errors.js";
import { logModelCall } from "./log.js";
import { formatSources, readJson } from "./prompt.js";
import { checkReferences, ReferenceList } from "./references.js";
import { LlmError, type LlmClient, type ObjectRequest, type TextRequest, type TextResult } from "./types.js";

// The reasoning of the model counts toward this limit, so a long chapter needs a large limit.
// The SDK refuses a large limit on a request with no streaming, so each request streams.
const MAX_TOKENS = 64000;

// For these models, the API can run a refused request again on a different model.
// See "Refusal Fallbacks" in the Claude API documentation.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Sdk = Pick<Anthropic, "messages" | "beta">;

interface AnyResponse {
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: Array<{ type: string; text?: string; citations?: Array<Record<string, unknown>> | null }>;
  usage?: { output_tokens?: number };
}

export class AnthropicClient implements LlmClient {
  private readonly sdk: Sdk;

  constructor(
    private readonly config: ModelConfig,
    sdk?: Sdk,
  ) {
    this.sdk = sdk ?? new Anthropic({ apiKey: config.apiKey });
  }

  private get fallback() {
    return FALLBACK_MODELS.has(this.config.model);
  }

  private effort() {
    // The API accepts low, medium, high, xhigh, and max. It rejects other levels with a clear message.
    return this.config.reasoning ? { effort: this.config.reasoning as "low" | "medium" | "high" | "xhigh" | "max" } : {};
  }

  private async call(params: Record<string, unknown>): Promise<AnyResponse> {
    const base = { model: this.config.model, max_tokens: MAX_TOKENS, ...params };
    const start = Date.now();
    let response: AnyResponse;
    try {
      const stream = this.fallback
        ? this.sdk.beta.messages.stream({ ...base, betas: [FALLBACK_BETA], fallbacks: "default" } as never)
        : this.sdk.messages.stream(base as never);
      response = (await stream.finalMessage()) as unknown as AnyResponse;
    } catch (error) {
      logModelCall(start, `failed: ${error instanceof Error ? error.message : String(error)}`);
      throw toLlmError(error, this.config);
    }
    logModelCall(start, `stop reason "${response.stop_reason ?? "none"}", ${response.usage?.output_tokens ?? 0} output tokens`);
    return response;
  }

  private checkStop(response: AnyResponse): void {
    if (response.stop_reason === "refusal") {
      const reason = response.stop_details?.explanation ?? response.stop_details?.category ?? "no reason given";
      throw new LlmError(`The model refused the request (${reason}).`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmError(
        `The answer of the model was too long and stopped before the end (${response.usage?.output_tokens ?? 0} output tokens). ` +
          "The reasoning counts as output. If the model reasons too long, set a lower LLM_REASONING.",
      );
    }
  }

  private static textOf(response: AnyResponse): string {
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }

  async object<T>(request: ObjectRequest<T>): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (request.sources && request.sources.length > 0) {
      // The sources come first and have a cache marker, so that later calls with the same sources cost less.
      content.push({ type: "text", text: formatSources(request.sources), cache_control: { type: "ephemeral" } });
    }
    for (const image of request.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: Buffer.from(image.data).toString("base64") } });
    }
    content.push({ type: "text", text: request.prompt });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
    // The format has no parse function, so the SDK does not parse the answer. Its parse throws on an incomplete answer,
    // before this code can check the stop reason or ask again.
    const { type, schema } = zodOutputFormat(request.schema as never);
    const format = { type, schema };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await this.call({
        system: request.system,
        messages,
        output_config: { ...this.effort(), format },
      });
      this.checkStop(response);
      const text = AnthropicClient.textOf(response);
      let value: unknown;
      try {
        value = readJson(text);
      } catch {
        value = undefined;
      }
      const result = request.schema.safeParse(value);
      if (result.success) return result.data;
      messages.push(
        { role: "assistant", content: text || "(no text)" },
        { role: "user", content: `The JSON does not match the schema: ${result.error.message}. Answer again with valid JSON.` },
      );
    }
    throw new LlmError("The model did not return JSON that matches the schema.");
  }

  async text(request: TextRequest): Promise<TextResult> {
    const [first, ...rest] = request.messages;
    if (!first || first.role !== "user") throw new Error("The first message must come from the user.");

    // Citations must be on for all documents or for none. The last document has the cache marker.
    const documents: Anthropic.ContentBlockParam[] = request.sources.map((source, i) => ({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: source.text },
      title: source.title,
      citations: { enabled: true },
      ...(i === request.sources.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [...documents, { type: "text", text: first.content }] },
      ...rest.map((message) => ({ role: message.role, content: message.content })),
    ];
    const response = await this.call({
      system: request.system,
      messages,
      ...(this.config.reasoning ? { output_config: this.effort() } : {}),
    });
    this.checkStop(response);

    // Each text block can carry citations. Put a reference number after the cited text.
    const references = new ReferenceList();
    let text = "";
    for (const block of response.content) {
      if (block.type !== "text") continue;
      text += block.text ?? "";
      for (const citation of block.citations ?? []) {
        const source = request.sources[Number(citation.document_index)];
        const quote = typeof citation.cited_text === "string" ? citation.cited_text : "";
        if (source && quote) text += ` [${references.add(source.id, quote)}]`;
      }
    }
    return checkReferences(text.trim(), references.list(), request.sources);
  }
}

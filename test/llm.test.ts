import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelConfig } from "../src/config.js";
import { AnthropicClient } from "../src/llm/anthropic.js";
import { LlmError, setModelLog, type Source } from "../src/llm/index.js";
import { OPENROUTER_URL, OpenAiClient, openAiOptions, strictJsonSchema } from "../src/llm/openai.js";
import { checkReferences, containsQuote } from "../src/llm/references.js";

const source: Source = {
  id: "3.2",
  title: "Indexes",
  text: "An index makes the lookup of rows faster. Each index makes writes slower.",
};
const schema = z.object({ facts: z.array(z.string()) });

function anthropicConfig(model = "claude-haiku-4-5", reasoning: ModelConfig["reasoning"] = null): ModelConfig {
  return { provider: "anthropic", model, apiKey: "key", reasoning };
}

// A fake SDK that records the requests and returns the answers in order.
function fakeAnthropic(answers: unknown[]) {
  const requests: { kind: string; params: Record<string, unknown> }[] = [];
  const answer = (kind: string) => async (params: Record<string, unknown>) => {
    requests.push({ kind, params });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sdk = {
    messages: { parse: answer("parse"), create: answer("create") },
    beta: { messages: { parse: answer("beta.parse"), create: answer("beta.create") } },
  };
  return { sdk: sdk as unknown as ConstructorParameters<typeof AnthropicClient>[1], requests };
}

function fakeOpenAi(answers: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const sdk = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  return { sdk: sdk as unknown as ConstructorParameters<typeof OpenAiClient>[1], requests };
}

const chat = (content: string | null, finish_reason = "stop", reasoning?: string) => ({
  choices: [{ finish_reason, message: { role: "assistant", content, refusal: null, reasoning } }],
  usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 850 } },
});

describe("AnthropicClient", () => {
  it("returns parsed JSON, and puts the sources first with a cache marker", async () => {
    const { sdk, requests } = fakeAnthropic([
      { stop_reason: "end_turn", content: [{ type: "text", text: '{"facts":["a"]}' }], parsed_output: { facts: ["a"] } },
    ]);
    const client = new AnthropicClient(anthropicConfig("claude-haiku-4-5", "high"), sdk);
    expect(await client.object({ system: "s", sources: [source], prompt: "p", schema })).toEqual({ facts: ["a"] });

    const { kind, params } = requests[0]!;
    expect(kind).toBe("parse");
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.output_config).toMatchObject({ effort: "high", format: { type: "json_schema" } });
    const content = (params.messages as { content: { text: string; cache_control?: unknown }[] }[])[0]!.content;
    expect(content[0]!.text).toContain('<source id="3.2" title="Indexes">');
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(content[1]!.text).toBe("p");
  });

  it("asks again once if the JSON does not match the schema", async () => {
    const { sdk, requests } = fakeAnthropic([
      { stop_reason: "end_turn", content: [{ type: "text", text: '{"wrong":1}' }], parsed_output: null },
      { stop_reason: "end_turn", content: [{ type: "text", text: '{"facts":["b"]}' }], parsed_output: { facts: ["b"] } },
    ]);
    const client = new AnthropicClient(anthropicConfig(), sdk);
    expect(await client.object({ system: "s", prompt: "p", schema })).toEqual({ facts: ["b"] });
    expect((requests[1]!.params.messages as unknown[]).length).toBe(3);
  });

  it("uses the server-side fallback for the models that support it", async () => {
    const { sdk, requests } = fakeAnthropic([
      { stop_reason: "end_turn", content: [{ type: "text", text: "x" }], parsed_output: { facts: [] } },
    ]);
    await new AnthropicClient(anthropicConfig("claude-opus-5-5"), sdk).object({ system: "s", prompt: "p", schema });
    expect(requests[0]!.kind).toBe("beta.parse");
    expect(requests[0]!.params).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  });

  it("reports a refusal", async () => {
    const { sdk } = fakeAnthropic([
      { stop_reason: "refusal", stop_details: { category: "cyber", explanation: null }, content: [] },
    ]);
    await expect(new AnthropicClient(anthropicConfig(), sdk).object({ system: "s", prompt: "p", schema })).rejects.toThrow(
      /refused the request \(cyber\)/,
    );
  });

  it("turns citations into numbered references", async () => {
    const { sdk, requests } = fakeAnthropic([
      {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Indexes make reads faster", citations: [{ type: "char_location", document_index: 0, cited_text: "An index makes the lookup of rows faster." }] },
          { type: "text", text: " but writes slower.", citations: [{ type: "char_location", document_index: 0, cited_text: "Each index makes writes slower." }] },
        ],
      },
    ]);
    const result = await new AnthropicClient(anthropicConfig(), sdk).text({
      system: "s",
      sources: [source],
      messages: [{ role: "user", content: "What does an index cost?" }],
    });
    expect(result.text).toBe("Indexes make reads faster [1] but writes slower. [2]");
    expect(result.references.map((reference) => reference.quote)).toEqual([
      "An index makes the lookup of rows faster.",
      "Each index makes writes slower.",
    ]);
    const document = (requests[0]!.params.messages as { content: Record<string, unknown>[] }[])[0]!.content[0]!;
    expect(document).toMatchObject({ type: "document", citations: { enabled: true }, cache_control: { type: "ephemeral" } });
  });

  it("gives a clear message for a key that is not valid", async () => {
    const { sdk } = fakeAnthropic([new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers())]);
    await expect(new AnthropicClient(anthropicConfig(), sdk).object({ system: "s", prompt: "p", schema })).rejects.toThrow(
      /did not accept the API key/,
    );
  });
});

describe("OpenAiClient", () => {
  const config: ModelConfig = { provider: "openai", model: "some-model", apiKey: "key", reasoning: "low" };

  it("sends a strict JSON schema and the reasoning level", async () => {
    const { sdk, requests } = fakeOpenAi([chat('{"facts":["a"]}')]);
    expect(await new OpenAiClient(config, sdk).object({ system: "s", sources: [source], prompt: "p", schema })).toEqual({ facts: ["a"] });
    expect(requests[0]).toMatchObject({
      model: "some-model",
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true } },
    });
  });

  it("asks for JSON in the prompt if the model does not accept a JSON schema", async () => {
    const unsupported = new OpenAI.BadRequestError(400, undefined, "response_format json_schema is not supported", new Headers());
    const { sdk, requests } = fakeOpenAi([unsupported, chat('```json\n{"facts":["c"]}\n```')]);
    expect(await new OpenAiClient(config, sdk).object({ system: "s", prompt: "p", schema })).toEqual({ facts: ["c"] });
    expect(requests[1]!.response_format).toBeUndefined();
    expect(JSON.stringify(requests[1]!.messages)).toContain("JSON schema");
  });

  it("turns reference markers into numbered references and removes invented quotes", async () => {
    const { sdk } = fakeOpenAi([
      chat('Reads get faster [S1: "An index makes the lookup of rows faster."] and disks fill [S1: "Indexes use no space."].'),
    ]);
    const result = await new OpenAiClient(config, sdk).text({
      system: "s",
      sources: [source],
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.text).toBe("Reads get faster [1] and disks fill.");
    expect(result.references).toEqual([{ number: 1, sourceId: "3.2", quote: "An index makes the lookup of rows faster." }]);
  });

  it("reports an answer that is too long", async () => {
    const { sdk } = fakeOpenAi([chat("{", "length")]);
    await expect(new OpenAiClient(config, sdk).object({ system: "s", prompt: "p", schema })).rejects.toThrow(LlmError);
  });

  it("sends the reasoning level to OpenRouter in its own format", async () => {
    const { sdk, requests } = fakeOpenAi([chat('{"facts":["a"]}')]);
    await new OpenAiClient({ ...config, provider: "openrouter", reasoning: "high" }, sdk).object({ system: "s", prompt: "p", schema });
    expect(requests[0]).toMatchObject({ reasoning: { effort: "high" } });
    expect(requests[0]).not.toHaveProperty("reasoning_effort");
  });

  it("sends the OpenRouter providers in order, with no fallback to other providers", async () => {
    const { sdk, requests } = fakeOpenAi([chat('{"facts":["a"]}'), chat('{"facts":["b"]}')]);
    await new OpenAiClient({ ...config, provider: "openrouter", providers: ["deepinfra", "together"] }, sdk).object({ system: "s", prompt: "p", schema });
    expect(requests[0]).toMatchObject({ provider: { order: ["deepinfra", "together"], allow_fallbacks: false } });
    await new OpenAiClient({ ...config, providers: ["deepinfra"] }, sdk).object({ system: "s", prompt: "p", schema });
    expect(requests[1]).not.toHaveProperty("provider");
  });

  it("names the providers if no provider serves the model", async () => {
    const notFound = new OpenAI.NotFoundError(404, undefined, "No endpoints found", new Headers());
    const { sdk } = fakeOpenAi([notFound]);
    const client = new OpenAiClient({ ...config, provider: "openrouter", providers: ["deepinfra"] }, sdk);
    await expect(client.object({ system: "s", prompt: "p", schema })).rejects.toThrow(/no provider in OPENROUTER_PROVIDERS \(deepinfra\)/);
  });

  it("asks one more time after an empty answer", async () => {
    const { sdk, requests } = fakeOpenAi([chat(null, "stop", "The answer is in the reasoning."), chat("Indexes cost space.")]);
    const result = await new OpenAiClient(config, sdk).text({ system: "s", sources: [], messages: [{ role: "user", content: "q" }] });
    expect(result.text).toBe("Indexes cost space.");
    expect(requests).toHaveLength(2);
  });

  it("reports two empty answers with the details", async () => {
    const { sdk } = fakeOpenAi([chat("", "stop", "Thinking."), chat("  ", "stop", "Thinking.")]);
    const request = new OpenAiClient(config, sdk).text({ system: "s", sources: [], messages: [{ role: "user", content: "q" }] });
    await expect(request).rejects.toThrow(/empty answer two times \(finish reason "stop", 900 output tokens, 850 of them for reasoning, text only in the reasoning field\)/);
  });

  it("logs each model call with the time and the result", async () => {
    const lines: string[] = [];
    setModelLog((line) => lines.push(line));
    try {
      const { sdk } = fakeOpenAi([chat(""), chat("Indexes cost space.")]);
      await new OpenAiClient(config, sdk).text({ system: "s", sources: [], messages: [{ role: "user", content: "q" }] });
    } finally {
      setModelLog(null);
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Model call: \d+\.\d s, finish reason "stop", 900 output tokens, 850 of them for reasoning, empty answer$/);
    expect(lines[1]).not.toContain("empty answer");
  });

  it("uses the OpenRouter URL for OpenRouter", () => {
    expect(openAiOptions({ ...config, provider: "openrouter" })).toMatchObject({ baseURL: OPENROUTER_URL });
    expect(openAiOptions(config)).not.toHaveProperty("baseURL");
  });
});

describe("helpers", () => {
  it("makes a strict JSON schema", () => {
    const strict = strictJsonSchema(z.object({ a: z.string(), b: z.object({ c: z.number().nullable() }) }));
    expect(strict).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "object", properties: { c: { type: ["number", "null"] } }, required: ["c"], additionalProperties: false },
      },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });

  it("accepts quotes with other spaces and quote characters", () => {
    const sources = [{ id: "s", title: "t", text: "It is “fast”,\nand it is small." }];
    const result = checkReferences("A [1] B [2]", [
      { number: 1, sourceId: "s", quote: 'it is "fast", and' },
      { number: 2, sourceId: "s", quote: "it is slow" },
    ], sources);
    expect(result).toEqual({ text: "A [1] B", references: [{ number: 1, sourceId: "s", quote: 'it is "fast", and' }] });
  });
});

describe("containsQuote", () => {
  const markdown = "-   **UNION ALL** does not remove duplicates, so it is faster than **UNION**.\n\n### 3\\. COUNT(column\\_name):\n\nIt counts `non-null` values.";

  it("ignores Markdown formatting in the text and in the quote", () => {
    expect(containsQuote(markdown, "UNION ALL does not remove duplicates, so it is faster than UNION.")).toBe(true);
    expect(containsQuote(markdown, "3. COUNT(column_name):")).toBe(true);
    expect(containsQuote(markdown, "It counts **non-null** values.")).toBe(true);
  });

  it("accepts a quote that the model shortened with an ellipsis", () => {
    expect(containsQuote(markdown, "UNION ALL does not remove duplicates ... faster than UNION")).toBe(true);
  });

  it("rejects a quote with other words", () => {
    expect(containsQuote(markdown, "UNION ALL never removes duplicates")).toBe(false);
    expect(containsQuote(markdown, "")).toBe(false);
  });
});

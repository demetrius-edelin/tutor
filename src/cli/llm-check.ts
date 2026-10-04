import { z } from "zod";
import { ConfigError, loadEnvFile, modelConfig } from "../config.js";
import { encodePng } from "../ingest/core/png.js";
import { createClient, LlmError, setModelLog, type Source } from "../llm/index.js";

// Check the model in .env with one JSON request, one text request with references, and one request with an image.

const source: Source = {
  id: "sample",
  title: "Indexes",
  text:
    "An index is a data structure that makes the lookup of rows faster. " +
    "A B-tree index keeps its keys in sorted order, so it supports range queries. " +
    "Each index makes writes slower, because the database must update the index too.",
};

async function main(): Promise<void> {
  loadEnvFile();
  const config = modelConfig();
  const providers = config.providers?.length ? `\nOpenRouter providers: ${config.providers.join(", ")} (no others)` : "";
  console.log(`\nProvider: ${config.provider}\nModel: ${config.model}${providers}\nReasoning: ${config.reasoning ?? "default of the model"}\n`);
  const client = createClient(config);
  setModelLog((line) => console.log(`   (${line})`));

  let start = Date.now();
  const facts = await client.object({
    system: "You extract facts from a text.",
    sources: [source],
    prompt: "List the facts in the source. Give each fact as one short sentence.",
    schema: z.object({ facts: z.array(z.string()) }),
  });
  console.log(`1. JSON answer (${((Date.now() - start) / 1000).toFixed(1)} s):`);
  for (const fact of facts.facts) console.log(`   - ${fact}`);

  start = Date.now();
  const answer = await client.text({
    system: "You are a tutor. Explain in two or three sentences.",
    sources: [source],
    messages: [{ role: "user", content: "What is the cost of an index?" }],
  });
  console.log(`\n2. Text answer with references (${((Date.now() - start) / 1000).toFixed(1)} s):\n   ${answer.text}`);
  for (const reference of answer.references) console.log(`   [${reference.number}] "${reference.quote}"`);
  if (answer.references.length === 0) console.log("   Warning: the answer has no valid reference.");

  // A red square. Ingest and refresh send the images of a book in the same way.
  const red = encodePng({ width: 64, height: 64, channels: 3, data: new Uint8Array(64 * 64 * 3).map((_, i) => (i % 3 === 0 ? 220 : 30)) });
  start = Date.now();
  try {
    const seen = await client.object({
      system: "You describe images.",
      images: [{ mediaType: "image/png", data: red }],
      prompt: "What is the main color of the image? Answer with one word.",
      schema: z.object({ color: z.string() }),
    });
    console.log(`\n3. Image answer (${((Date.now() - start) / 1000).toFixed(1)} s): the color is "${seen.color}".`);
    if (!/red/i.test(seen.color)) console.log("   Warning: the image is red. The model did not read the image correctly.");
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    console.log(`\n3. Image answer: the model did not accept the image. ${error.message}`);
    console.log("   Ingest and refresh then keep the image placeholders. The other parts of the tutor work.");
  }
  console.log("\nThe model works.\n");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof LlmError) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

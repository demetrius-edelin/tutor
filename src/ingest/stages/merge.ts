import { z } from "zod";
import type { LlmClient } from "../../llm/index.js";
import { normalizeQuote } from "../../llm/references.js";
import { addModule, findModule, sameName, uniqueSlug, type ConceptMap, type MapSource } from "../map.js";
import { LEVELS, type ConceptSource, type FoundConcept } from "./types.js";

// Stage 4 of ingest: add the concepts of a chapter to the concept map of the subject.
// The model sees only the names of the concepts, not the book text, so the request stays small.

const MergeSchema = z.object({
  newModules: z.array(z.string()),
  concepts: z.array(
    z.object({
      id: z.string(),
      action: z.enum(["add", "join"]),
      joinWith: z.string().nullable(),
      module: z.string(),
      level: z.enum(LEVELS),
      prerequisites: z.array(z.string()),
    }),
  ),
});

const MERGE_SYSTEM = `You keep the concept map of a subject of study. The map puts the concepts into modules. A module is a group of 5 to 20 related concepts, for example "Indexes" or "Window functions".
You add the new concepts of a chapter to the map.`;

function mapListing(map: ConceptMap): string {
  if (map.concepts.length === 0) return "The map is empty.";
  return [...map.modules]
    .sort((a, b) => a.position - b.position)
    .map((module) => {
      const concepts = map.concepts.filter((concept) => sameName(concept.module, module.name));
      return [`Module: ${module.name}`, ...concepts.map((concept) => `  - ${concept.slug}: ${concept.name}`)].join("\n");
    })
    .join("\n");
}

function mergePrompt(map: ConceptMap, chapterTitle: string, found: FoundConcept[], ids: string[]): string {
  const concepts = found.map((concept, i) => `${ids[i]}: ${concept.name}: ${concept.objective} [${concept.kind}, ${concept.level}]`);
  return `The concept map now:
${mapListing(map)}

The new concepts of the chapter "${chapterTitle}":
${concepts.join("\n")}

Give one entry for each new concept, with its id:
- action "join": the new concept is the same idea as a concept in the map. Give the slug of that concept in joinWith. Use "join" only for the same idea, not for a related idea.
- action "add": the concept is not in the map. joinWith is null.
- module: the name of a module in the map, or a name from newModules. Use a module in the map if the concept fits it. Put the names of new modules in newModules, in the order of the book. A module name has 1 to 5 words.
- level: "basic", "intermediate", or "advanced".
- prerequisites: up to 3 concepts that the learner must know first. Use the slugs of concepts in the map or the ids of new concepts. Give an empty list if the concept needs no other concept.`;
}

export interface MergeStats {
  added: number;
  joined: number;
}

export async function mergeChapter(
  llm: LlmClient,
  map: ConceptMap,
  chapterTitle: string,
  found: FoundConcept[],
  toMapSource: (source: ConceptSource) => MapSource,
): Promise<MergeStats> {
  // A concept with the same name as a concept in the map joins it without a model request.
  // Thus, a book that is ingested again keeps its concepts and the progress of the learner.
  let joined = 0;
  const pending: FoundConcept[] = [];
  for (const concept of found) {
    const match = map.concepts.find((other) => normalizeQuote(other.name) === normalizeQuote(concept.name));
    if (!match) {
      pending.push(concept);
      continue;
    }
    for (const source of concept.sources.map(toMapSource)) {
      if (!match.sources.some((other) => other.key === source.key)) match.sources.push(source);
    }
    joined++;
  }
  if (pending.length === 0) return { added: 0, joined };
  found = pending;

  const ids = found.map((_, i) => `n${i + 1}`);
  const result = await llm.object({ system: MERGE_SYSTEM, prompt: mergePrompt(map, chapterTitle, found, ids), schema: MergeSchema });
  const decisions = new Map(result.concepts.map((decision) => [decision.id, decision]));

  for (const name of result.newModules) if (name.trim()) addModule(map, name);

  const slugOf = new Map<string, string>();
  const added = new Set<string>();
  found.forEach((concept, i) => {
    const id = ids[i]!;
    const decision = decisions.get(id);
    const target =
      decision?.action === "join" && decision.joinWith ? map.concepts.find((other) => other.slug === decision.joinWith) : undefined;
    if (target) {
      for (const source of concept.sources.map(toMapSource)) {
        if (!target.sources.some((other) => other.key === source.key)) target.sources.push(source);
      }
      slugOf.set(id, target.slug);
      joined++;
      return;
    }
    // Without a usable decision, the concept goes into a module with the name of the chapter.
    const module = decision?.module.trim() ? (findModule(map, decision.module) ?? addModule(map, decision.module)) : addModule(map, chapterTitle);
    const slug = uniqueSlug(map, concept.name);
    map.concepts.push({
      slug,
      name: concept.name,
      objective: concept.objective,
      kind: concept.kind,
      level: decision?.level ?? concept.level,
      module: module.name,
      sources: concept.sources.map(toMapSource),
      prerequisites: [],
      rowId: null,
    });
    slugOf.set(id, slug);
    added.add(id);
  });

  // Prerequisites can point to new concepts of the same chapter, so they come after all concepts.
  for (const id of added) {
    const concept = map.concepts.find((other) => other.slug === slugOf.get(id))!;
    for (const reference of decisions.get(id)?.prerequisites.slice(0, 3) ?? []) {
      const slug = slugOf.get(reference) ?? (map.concepts.some((other) => other.slug === reference) ? reference : undefined);
      if (!slug || slug === concept.slug || concept.prerequisites.includes(slug)) continue;
      const prerequisite = map.concepts.find((other) => other.slug === slug)!;
      if (prerequisite.prerequisites.includes(concept.slug)) continue;
      concept.prerequisites.push(slug);
    }
  }
  return { added: added.size, joined };
}

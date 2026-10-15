import type { Db } from "../db/index.js";
import { slugify } from "./core/text.js";
import type { Kind, Level } from "./stages/types.js";

// The concept map of a subject, in memory. Ingest loads it from the database, adds the
// concepts of a book, and saves the changes.

export interface MapSource {
  // "<book slug>#<section id>", for example "pro-git#3.2".
  key: string;
  // A short description for people, for example "Pro Git, 3.2 Branches in a Nutshell, p. 45".
  display: string;
  quote: string;
  quoteFound: boolean;
  // The place of the section in the books, from sectionPlace. It gives the book order of the map.
  place: number;
}

export interface MapConcept {
  slug: string;
  name: string;
  objective: string;
  kind: Kind;
  level: Level;
  module: string;
  sources: MapSource[];
  // The slugs of the prerequisites.
  prerequisites: string[];
  // The database id. Null for a concept that is not in the database yet.
  rowId: number | null;
}

export interface MapModule {
  name: string;
  position: number;
  rowId: number | null;
}

export interface ConceptMap {
  modules: MapModule[];
  concepts: MapConcept[];
}

export const emptyMap = (): ConceptMap => ({ modules: [], concepts: [] });

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findModule(map: ConceptMap, name: string): MapModule | undefined {
  return map.modules.find((module) => sameName(module.name, name));
}

export function addModule(map: ConceptMap, name: string): MapModule {
  const existing = findModule(map, name);
  if (existing) return existing;
  const module = { name: name.trim(), position: Math.max(0, ...map.modules.map((item) => item.position)) + 1, rowId: null };
  map.modules.push(module);
  return module;
}

export function uniqueSlug(map: ConceptMap, name: string): string {
  const base = slugify(name, 50);
  let slug = base;
  for (let n = 2; map.concepts.some((concept) => concept.slug === slug); n++) slug = `${base}-${n}`;
  return slug;
}

interface ConceptRow {
  id: number;
  slug: string;
  name: string;
  objective: string;
  kind: Kind;
  level: Level;
  module: string;
}

interface SourceRow {
  concept_id: number;
  quote: string;
  book_id: number;
  book_slug: string;
  book_title: string;
  chapter: number;
  number: number;
  title: string;
  page: string | null;
}

export function sourceDisplay(bookTitle: string, sectionId: string, sectionTitle: string, page: string | null): string {
  return `${bookTitle}, ${sectionId} ${sectionTitle}${page ? `, p. ${page}` : ""}`;
}

// The book order: the books in the order of ingest (the id of the book), then the chapters and the sections.
// SECTION_PLACE is the same formula in SQL, for a section with the alias "s".
export function sectionPlace(bookId: number, chapter: number, section: number): number {
  return bookId * 1_000_000_000_000 + chapter * 1_000_000 + section;
}

const SECTION_PLACE = "(s.book_id * 1000000000000 + s.chapter * 1000000 + s.number)";

// SQL for the place of the concept with the alias "c": the place of its first source. It is NULL for a concept with no source.
export const CONCEPT_PLACE = `(SELECT MIN(${SECTION_PLACE}) FROM concept_sources cs JOIN sections s ON s.id = cs.section_id WHERE cs.concept_id = c.id)`;

// Put the map in the book order. A concept takes the place of its first source, and a module takes the place of its first concept.
// The modules get new numbers in this order. A concept or a module with no source keeps its order, at the end.
export function sortMap(map: ConceptMap): void {
  const placeOf = (concept: MapConcept) => Math.min(...concept.sources.map((source) => source.place));
  const before = new Map(map.concepts.map((concept, i) => [concept, i]));
  // Infinity minus Infinity is NaN, which counts as equal. Then the old order decides.
  map.concepts.sort((a, b) => placeOf(a) - placeOf(b) || before.get(a)! - before.get(b)!);
  const modulePlace = (module: MapModule) =>
    Math.min(...map.concepts.filter((concept) => sameName(concept.module, module.name)).map(placeOf));
  [...map.modules]
    .sort((a, b) => modulePlace(a) - modulePlace(b) || a.position - b.position)
    .forEach((module, i) => {
      module.position = i + 1;
    });
}

export function loadMap(db: Db, subjectId: number): ConceptMap {
  const modules = db
    .prepare("SELECT id, name, position FROM modules WHERE subject_id = ? ORDER BY position")
    .all(subjectId) as { id: number; name: string; position: number }[];
  const concepts = db
    .prepare(
      `SELECT c.id, c.slug, c.name, c.objective, c.kind, c.level, m.name AS module
       FROM concepts c JOIN modules m ON m.id = c.module_id WHERE c.subject_id = ?
       ORDER BY m.position, ${CONCEPT_PLACE} IS NULL, ${CONCEPT_PLACE}, c.id`,
    )
    .all(subjectId) as ConceptRow[];
  const sources = db
    .prepare(
      `SELECT cs.concept_id, cs.quote, b.id AS book_id, b.slug AS book_slug, b.title AS book_title, s.chapter, s.number, s.title, s.page
       FROM concept_sources cs JOIN sections s ON s.id = cs.section_id JOIN books b ON b.id = s.book_id
       WHERE b.subject_id = ? ORDER BY s.chapter, s.number`,
    )
    .all(subjectId) as SourceRow[];
  const prereqs = db
    .prepare(
      `SELECT p.concept_id, c.slug FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id WHERE c.subject_id = ?`,
    )
    .all(subjectId) as { concept_id: number; slug: string }[];

  return {
    modules: modules.map((row) => ({ name: row.name, position: row.position, rowId: row.id })),
    concepts: concepts.map((row) => ({
      slug: row.slug,
      name: row.name,
      objective: row.objective,
      kind: row.kind,
      level: row.level,
      module: row.module,
      rowId: row.id,
      prerequisites: prereqs.filter((prereq) => prereq.concept_id === row.id).map((prereq) => prereq.slug),
      sources: sources
        .filter((source) => source.concept_id === row.id)
        .map((source) => {
          const sectionId = `${source.chapter}.${source.number}`;
          return {
            key: `${source.book_slug}#${sectionId}`,
            display: sourceDisplay(source.book_title, sectionId, source.title, source.page),
            quote: source.quote,
            quoteFound: true,
            place: sectionPlace(source.book_id, source.chapter, source.number),
          };
        }),
    })),
  };
}

// Save the new modules, the new concepts, and the new sources and prerequisites, and the numbers of all modules.
// sectionRows gives the database id of each section key.
export function saveMap(db: Db, subjectId: number, map: ConceptMap, sectionRows: Map<string, number>): void {
  const insertModule = db.prepare("INSERT INTO modules (subject_id, position, name) VALUES (?, ?, ?)");
  const updateModule = db.prepare("UPDATE modules SET position = ? WHERE id = ?");
  const insertConcept = db.prepare(
    "INSERT INTO concepts (subject_id, module_id, slug, name, objective, kind, level) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSource = db.prepare("INSERT OR IGNORE INTO concept_sources (concept_id, section_id, quote) VALUES (?, ?, ?)");
  const insertPrereq = db.prepare("INSERT OR IGNORE INTO concept_prereqs (concept_id, prereq_id) VALUES (?, ?)");

  for (const module of map.modules) {
    if (module.rowId === null) module.rowId = Number(insertModule.run(subjectId, module.position, module.name).lastInsertRowid);
    else updateModule.run(module.position, module.rowId);
  }
  for (const concept of map.concepts) {
    if (concept.rowId !== null) continue;
    const module = findModule(map, concept.module);
    if (!module?.rowId) throw new Error(`The module "${concept.module}" of the concept "${concept.name}" does not exist.`);
    concept.rowId = Number(
      insertConcept.run(subjectId, module.rowId, concept.slug, concept.name, concept.objective, concept.kind, concept.level)
        .lastInsertRowid,
    );
  }
  const idOf = new Map(map.concepts.map((concept) => [concept.slug, concept.rowId!]));
  for (const concept of map.concepts) {
    for (const source of concept.sources) {
      const section = sectionRows.get(source.key);
      if (section !== undefined) insertSource.run(concept.rowId, section, source.quote);
    }
    for (const prereq of concept.prerequisites) {
      const prereqId = idOf.get(prereq);
      if (prereqId !== undefined) insertPrereq.run(concept.rowId, prereqId);
    }
  }
}

// The concepts of a preview as data, for the app: only the concepts with a source in the sections of the run.
// The modules are in the order of the concept map.
export interface PreviewModule {
  // The number of the module on the concept map.
  position: number;
  name: string;
  concepts: {
    name: string;
    objective: string;
    kind: Kind;
    level: Level;
    sources: { text: string; quoteFound: boolean }[];
    // The names of the prerequisites.
    needs: string[];
    // True for a concept that is on the concept map already. The run joins its own concept to it.
    onMap: boolean;
  }[];
}

// keys: the source keys of the sections of the run, for example "pro-git#3.2".
export function mapPreview(map: ConceptMap, keys: ReadonlySet<string>): PreviewModule[] {
  const nameOf = new Map(map.concepts.map((concept) => [concept.slug, concept.name]));
  return [...map.modules]
    .sort((a, b) => a.position - b.position)
    .map((module) => ({
      position: module.position,
      name: module.name,
      concepts: map.concepts
        .filter((concept) => sameName(concept.module, module.name) && concept.sources.some((source) => keys.has(source.key)))
        .map((concept) => ({
          name: concept.name,
          objective: concept.objective,
          kind: concept.kind,
          level: concept.level,
          sources: concept.sources.map((source) => ({ text: source.display, quoteFound: source.quoteFound })),
          needs: concept.prerequisites.map((slug) => nameOf.get(slug) ?? slug),
          onMap: concept.rowId !== null,
        })),
    }))
    .filter((module) => module.concepts.length > 0);
}

// The concept map as Markdown, for people to read.
export function mapToMarkdown(title: string, map: ConceptMap): string {
  const nameOf = new Map(map.concepts.map((concept) => [concept.slug, concept.name]));
  const lines = [`# Concept map: ${title}`, "", `${map.modules.length} modules, ${map.concepts.length} concepts.`, ""];
  const modules = [...map.modules].sort((a, b) => a.position - b.position);
  modules.forEach((module, i) => {
    const concepts = map.concepts.filter((concept) => sameName(concept.module, module.name));
    if (concepts.length === 0) return;
    lines.push(`## ${i + 1}. ${module.name}`, "");
    for (const concept of concepts) {
      lines.push(`- **${concept.name}** (${concept.level}, ${concept.kind}): ${concept.objective}`);
      for (const source of concept.sources) {
        lines.push(`  - Source: ${source.display}${source.quoteFound ? "" : " (the quote is not in the text)"}`);
      }
      if (concept.prerequisites.length > 0) {
        lines.push(`  - Needs: ${concept.prerequisites.map((slug) => nameOf.get(slug) ?? slug).join(", ")}`);
      }
    }
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

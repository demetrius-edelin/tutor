import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Db } from "../db/index.js";
import {
  STATUSES,
  type BookSummary,
  type ConceptMapView,
  type ModuleSummary,
  type ConceptView,
  type SectionView,
  type Status,
  type StatusCounts,
  type ThemeDetail,
  type ThemeSummary,
} from "./api-types.js";

interface ThemeRow {
  id: number;
  slug: string;
  name: string;
}

const noProgress = () => Object.fromEntries(STATUSES.map((status) => [status, 0])) as StatusCounts;

function progress(db: Db, themeId: number): StatusCounts {
  const counts = noProgress();
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM concepts WHERE theme_id = ? GROUP BY status").all(themeId) as {
    status: Status;
    n: number;
  }[];
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

function summary(db: Db, theme: ThemeRow): ThemeSummary {
  const count = (sql: string) => db.prepare(sql).pluck().get(theme.id) as number;
  return {
    slug: theme.slug,
    name: theme.name,
    books: count("SELECT COUNT(*) FROM books WHERE theme_id = ?"),
    modules: count("SELECT COUNT(*) FROM modules WHERE theme_id = ?"),
    concepts: count("SELECT COUNT(*) FROM concepts WHERE theme_id = ?"),
    progress: progress(db, theme.id),
  };
}

export function listThemes(db: Db): ThemeSummary[] {
  const themes = db.prepare("SELECT id, slug, name FROM themes ORDER BY name").all() as ThemeRow[];
  return themes.map((theme) => summary(db, theme));
}

function findTheme(db: Db, slug: string): ThemeRow | undefined {
  return db.prepare("SELECT id, slug, name FROM themes WHERE slug = ?").get(slug) as ThemeRow | undefined;
}

export function themeDetail(db: Db, slug: string): ThemeDetail | undefined {
  const theme = findTheme(db, slug);
  if (!theme) return undefined;
  const books = db
    .prepare(
      `SELECT b.slug, b.title, b.file,
         (SELECT COUNT(DISTINCT s.chapter) FROM sections s WHERE s.book_id = b.id) AS chapters,
         (SELECT COUNT(DISTINCT s.chapter) FROM sections s JOIN concept_sources cs ON cs.section_id = s.id WHERE s.book_id = b.id) AS chaptersWithConcepts,
         (SELECT COUNT(*) FROM sections s WHERE s.book_id = b.id) AS sections,
         (SELECT COALESCE(SUM(s.words), 0) FROM sections s WHERE s.book_id = b.id) AS words,
         (SELECT COUNT(DISTINCT cs.concept_id) FROM concept_sources cs JOIN sections s ON s.id = cs.section_id WHERE s.book_id = b.id) AS concepts
       FROM books b WHERE b.theme_id = ? ORDER BY b.created_at, b.id`,
    )
    .all(theme.id) as (Omit<BookSummary, "format"> & { file: string })[];
  const next = db
    .prepare(
      `SELECT c.id AS conceptId, c.name, c.objective, c.status, m.position AS modulePosition, m.name AS moduleName
       FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE c.theme_id = ? AND c.status IN ('queued', 'learning') ORDER BY c.queue_pos, c.id LIMIT 1`,
    )
    .get(theme.id) as
    | { conceptId: number; name: string; objective: string; status: Status; modulePosition: number; moduleName: string }
    | undefined;
  return {
    ...summary(db, theme),
    bookList: books.map(({ file, ...book }) => ({ ...book, format: extname(file).toLowerCase() === ".pdf" ? "pdf" : "epub" })),
    moduleList: moduleList(db, theme.id),
    nextToLearn: next
      ? {
          conceptId: next.conceptId,
          name: next.name,
          objective: next.objective,
          status: next.status,
          module: { position: next.modulePosition, name: next.moduleName },
        }
      : null,
  };
}

function moduleList(db: Db, themeId: number): ModuleSummary[] {
  const modules = db.prepare("SELECT id, position, name FROM modules WHERE theme_id = ? ORDER BY position").all(themeId) as {
    id: number;
    position: number;
    name: string;
  }[];
  const rows = db
    .prepare("SELECT module_id, status, COUNT(*) AS n FROM concepts WHERE theme_id = ? GROUP BY module_id, status")
    .all(themeId) as { module_id: number; status: Status; n: number }[];
  return modules.map((module) => {
    const counts = noProgress();
    for (const row of rows) if (row.module_id === module.id) counts[row.status] = row.n;
    return { ...module, concepts: STATUSES.reduce((sum, status) => sum + counts[status], 0), progress: counts };
  });
}

export function conceptMap(db: Db, slug: string): ConceptMapView | undefined {
  const theme = findTheme(db, slug);
  if (!theme) return undefined;
  const modules = db.prepare("SELECT id, position, name FROM modules WHERE theme_id = ? ORDER BY position").all(theme.id) as {
    id: number;
    position: number;
    name: string;
  }[];
  const concepts = db
    .prepare(
      "SELECT id, module_id, slug, name, objective, kind, level, status, starred FROM concepts WHERE theme_id = ? ORDER BY id",
    )
    .all(theme.id) as (Omit<ConceptView, "prerequisites" | "sources" | "starred"> & { module_id: number; starred: number })[];
  const prerequisites = db
    .prepare(
      `SELECT p.concept_id, c.slug, c.name FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id
       WHERE c.theme_id = ? ORDER BY c.id`,
    )
    .all(theme.id) as { concept_id: number; slug: string; name: string }[];
  const sources = db
    .prepare(
      `SELECT cs.concept_id, s.id AS sectionId, s.chapter, s.number, s.title, s.page, cs.quote, b.title AS book
       FROM concept_sources cs JOIN sections s ON s.id = cs.section_id JOIN books b ON b.id = s.book_id
       WHERE b.theme_id = ? ORDER BY b.id, s.chapter, s.number`,
    )
    .all(theme.id) as { concept_id: number; sectionId: number; chapter: number; number: number; title: string; page: string | null; quote: string; book: string }[];

  return {
    theme: { slug: theme.slug, name: theme.name },
    modules: modules.map((module) => ({
      ...module,
      concepts: concepts
        .filter((concept) => concept.module_id === module.id)
        .map(({ module_id: _module, ...concept }) => ({
          ...concept,
          starred: concept.starred === 1,
          prerequisites: prerequisites
            .filter((prerequisite) => prerequisite.concept_id === concept.id)
            .map(({ slug, name }) => ({ slug, name })),
          sources: sources
            .filter((source) => source.concept_id === concept.id)
            .map((source) => ({
              sectionId: source.sectionId,
              ref: `${source.chapter}.${source.number}`,
              book: source.book,
              title: source.title,
              page: source.page,
              quote: source.quote,
            })),
        })),
    })),
  };
}

export function section(db: Db, dataDir: string, id: number): SectionView | undefined {
  const row = db
    .prepare(
      `SELECT s.id, s.chapter, s.number, s.chapter_title, s.title, s.page, s.path, b.title AS book
       FROM sections s JOIN books b ON b.id = s.book_id WHERE s.id = ?`,
    )
    .get(id) as
    | { id: number; chapter: number; number: number; chapter_title: string; title: string; page: string | null; path: string; book: string }
    | undefined;
  if (!row) return undefined;
  // The path comes from the database. It must stay inside the data folder.
  const root = resolve(dataDir);
  const file = resolve(root, row.path);
  if (!file.startsWith(root + sep)) return undefined;
  return {
    id: row.id,
    book: row.book,
    chapterTitle: row.chapter_title,
    ref: `${row.chapter}.${row.number}`,
    title: row.title,
    page: row.page,
    markdown: readFileSync(file, "utf8"),
  };
}

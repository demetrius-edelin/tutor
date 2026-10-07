import { readFileSync, rmSync } from "node:fs";
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
  type SubjectDetail,
  type SubjectSummary,
} from "./api-types.js";

interface SubjectRow {
  id: number;
  slug: string;
  name: string;
}

const noProgress = () => Object.fromEntries(STATUSES.map((status) => [status, 0])) as StatusCounts;

function progress(db: Db, subjectId: number): StatusCounts {
  const counts = noProgress();
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM concepts WHERE subject_id = ? GROUP BY status").all(subjectId) as {
    status: Status;
    n: number;
  }[];
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

function summary(db: Db, subject: SubjectRow): SubjectSummary {
  const count = (sql: string) => db.prepare(sql).pluck().get(subject.id) as number;
  return {
    slug: subject.slug,
    name: subject.name,
    books: count("SELECT COUNT(*) FROM books WHERE subject_id = ?"),
    modules: count("SELECT COUNT(*) FROM modules WHERE subject_id = ?"),
    concepts: count("SELECT COUNT(*) FROM concepts WHERE subject_id = ?"),
    progress: progress(db, subject.id),
  };
}

export function listSubjects(db: Db): SubjectSummary[] {
  const subjects = db.prepare("SELECT id, slug, name FROM subjects ORDER BY name").all() as SubjectRow[];
  return subjects.map((subject) => summary(db, subject));
}

function findSubject(db: Db, slug: string): SubjectRow | undefined {
  return db.prepare("SELECT id, slug, name FROM subjects WHERE slug = ?").get(slug) as SubjectRow | undefined;
}

// Delete a subject and all its data. The foreign keys delete the rows of the books, the concepts, and the progress.
// Then the folder of the subject goes: the book copies, the section files, and the cached model results.
// Returns false if the subject does not exist.
export function deleteSubject(db: Db, dataDir: string, slug: string): boolean {
  const subject = findSubject(db, slug);
  if (!subject) return false;
  db.prepare("DELETE FROM subjects WHERE id = ?").run(subject.id);
  // The slug comes from the database. The folder must stay inside the folder of the subjects.
  const root = resolve(dataDir, "subjects");
  const folder = resolve(root, subject.slug);
  if (folder.startsWith(root + sep)) rmSync(folder, { recursive: true, force: true });
  return true;
}

export function subjectDetail(db: Db, slug: string): SubjectDetail | undefined {
  const subject = findSubject(db, slug);
  if (!subject) return undefined;
  const books = db
    .prepare(
      `SELECT b.slug, b.title, b.file,
         (SELECT COUNT(DISTINCT s.chapter) FROM sections s WHERE s.book_id = b.id) AS chapters,
         (SELECT COUNT(DISTINCT s.chapter) FROM sections s JOIN concept_sources cs ON cs.section_id = s.id WHERE s.book_id = b.id) AS chaptersWithConcepts,
         (SELECT COUNT(*) FROM sections s WHERE s.book_id = b.id) AS sections,
         (SELECT COALESCE(SUM(s.words), 0) FROM sections s WHERE s.book_id = b.id) AS words,
         (SELECT COUNT(DISTINCT cs.concept_id) FROM concept_sources cs JOIN sections s ON s.id = cs.section_id WHERE s.book_id = b.id) AS concepts
       FROM books b WHERE b.subject_id = ? ORDER BY b.created_at, b.id`,
    )
    .all(subject.id) as (Omit<BookSummary, "format"> & { file: string })[];
  const next = db
    .prepare(
      `SELECT c.id AS conceptId, c.name, c.objective, c.status, m.position AS modulePosition, m.name AS moduleName
       FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE c.subject_id = ? AND c.status IN ('queued', 'learning') ORDER BY c.queue_pos, c.id LIMIT 1`,
    )
    .get(subject.id) as
    | { conceptId: number; name: string; objective: string; status: Status; modulePosition: number; moduleName: string }
    | undefined;
  return {
    ...summary(db, subject),
    bookList: books.map(({ file, ...book }) => ({ ...book, format: extname(file).toLowerCase() === ".pdf" ? "pdf" : "epub" })),
    moduleList: moduleList(db, subject.id),
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

function moduleList(db: Db, subjectId: number): ModuleSummary[] {
  const modules = db.prepare("SELECT id, position, name FROM modules WHERE subject_id = ? ORDER BY position").all(subjectId) as {
    id: number;
    position: number;
    name: string;
  }[];
  const rows = db
    .prepare("SELECT module_id, status, COUNT(*) AS n FROM concepts WHERE subject_id = ? GROUP BY module_id, status")
    .all(subjectId) as { module_id: number; status: Status; n: number }[];
  return modules.map((module) => {
    const counts = noProgress();
    for (const row of rows) if (row.module_id === module.id) counts[row.status] = row.n;
    return { ...module, concepts: STATUSES.reduce((sum, status) => sum + counts[status], 0), progress: counts };
  });
}

export function conceptMap(db: Db, slug: string): ConceptMapView | undefined {
  const subject = findSubject(db, slug);
  if (!subject) return undefined;
  const modules = db.prepare("SELECT id, position, name FROM modules WHERE subject_id = ? ORDER BY position").all(subject.id) as {
    id: number;
    position: number;
    name: string;
  }[];
  const concepts = db
    .prepare(
      "SELECT id, module_id, slug, name, objective, kind, level, status, starred FROM concepts WHERE subject_id = ? ORDER BY id",
    )
    .all(subject.id) as (Omit<ConceptView, "prerequisites" | "sources" | "starred"> & { module_id: number; starred: number })[];
  const prerequisites = db
    .prepare(
      `SELECT p.concept_id, c.slug, c.name FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id
       WHERE c.subject_id = ? ORDER BY c.id`,
    )
    .all(subject.id) as { concept_id: number; slug: string; name: string }[];
  const sources = db
    .prepare(
      `SELECT cs.concept_id, s.id AS sectionId, s.chapter, s.number, s.title, s.page, cs.quote, b.title AS book
       FROM concept_sources cs JOIN sections s ON s.id = cs.section_id JOIN books b ON b.id = s.book_id
       WHERE b.subject_id = ? ORDER BY b.id, s.chapter, s.number`,
    )
    .all(subject.id) as { concept_id: number; sectionId: number; chapter: number; number: number; title: string; page: string | null; quote: string; book: string }[];

  return {
    subject: { slug: subject.slug, name: subject.name },
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

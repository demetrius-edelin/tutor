import type { Db } from "../db/index.js";
import type { QueueItem, QueueView, Status } from "../server/api-types.js";
import { TutorError } from "./diagnosis.js";

// The study queue of a theme: the concepts that the learner wants to learn, in order.
// The tutor teaches the first concept first.

const LEVEL_RANK = { basic: 0, intermediate: 1, advanced: 2 } as const;
const READY: Status[] = ["known", "mastered"];

interface QueueRow {
  id: number;
  slug: string;
  name: string;
  objective: string;
  kind: QueueItem["kind"];
  level: QueueItem["level"];
  queue_pos: number;
  module_id: number;
  module_position: number;
  module_name: string;
}

function themeOf(db: Db, slug: string): { id: number; slug: string; name: string } {
  const theme = db.prepare("SELECT id, slug, name FROM themes WHERE slug = ?").get(slug) as { id: number; slug: string; name: string } | undefined;
  if (!theme) throw new TutorError(`The theme "${slug}" does not exist.`, 404);
  return theme;
}

function queueRows(db: Db, themeId: number): QueueRow[] {
  return db
    .prepare(
      `SELECT c.id, c.slug, c.name, c.objective, c.kind, c.level, c.queue_pos, m.id AS module_id, m.position AS module_position, m.name AS module_name
       FROM concepts c JOIN modules m ON m.id = c.module_id
       WHERE c.theme_id = ? AND c.status IN ('queued', 'learning') ORDER BY c.queue_pos, c.id`,
    )
    .all(themeId) as QueueRow[];
}

function prerequisitesOf(db: Db, themeId: number): Map<number, { id: number; slug: string; name: string; status: Status }[]> {
  const rows = db
    .prepare(
      `SELECT p.concept_id, c.id, c.slug, c.name, c.status FROM concept_prereqs p JOIN concepts c ON c.id = p.prereq_id
       WHERE c.theme_id = ? ORDER BY c.id`,
    )
    .all(themeId) as { concept_id: number; id: number; slug: string; name: string; status: Status }[];
  const result = new Map<number, { id: number; slug: string; name: string; status: Status }[]>();
  for (const row of rows) {
    const list = result.get(row.concept_id) ?? [];
    list.push({ id: row.id, slug: row.slug, name: row.name, status: row.status });
    result.set(row.concept_id, list);
  }
  return result;
}

// The suggested order: a prerequisite in the queue comes before the concepts that need it.
// Then the module order, then the level from basic to advanced, then the current order.
export function suggestedOrder(rows: QueueRow[], prerequisites: Map<number, { id: number }[]>): number[] {
  const inQueue = new Set(rows.map((row) => row.id));
  const waiting = new Map(rows.map((row) => [row.id, new Set((prerequisites.get(row.id) ?? []).map((p) => p.id).filter((id) => inQueue.has(id) && id !== row.id))]));
  const priority = (row: QueueRow) => [row.module_position, LEVEL_RANK[row.level], row.queue_pos, row.id];
  const compare = (a: QueueRow, b: QueueRow) => {
    const [pa, pb] = [priority(a), priority(b)];
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
    return 0;
  };
  const order: number[] = [];
  const remaining = [...rows];
  while (remaining.length > 0) {
    const ready = remaining.filter((row) => [...waiting.get(row.id)!].every((id) => order.includes(id)));
    // A cycle of prerequisites has no ready concept. Then the concept with the best priority comes next.
    const next = (ready.length > 0 ? ready : remaining).sort(compare)[0]!;
    order.push(next.id);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return order;
}

export function queueView(db: Db, slug: string): QueueView {
  const theme = themeOf(db, slug);
  const rows = queueRows(db, theme.id);
  const prerequisites = prerequisitesOf(db, theme.id);
  const place = new Map(rows.map((row, i) => [row.id, i + 1]));
  const items = rows.map((row, i): QueueItem => {
    const own = (prerequisites.get(row.id) ?? []).map((prerequisite) => ({
      slug: prerequisite.slug,
      name: prerequisite.name,
      status: prerequisite.status,
      position: place.get(prerequisite.id) ?? null,
    }));
    const later = own.filter((prerequisite) => prerequisite.position !== null && prerequisite.position > i + 1);
    const missing = own.filter((prerequisite) => prerequisite.position === null && !READY.includes(prerequisite.status));
    const names = (list: typeof own) => list.map((prerequisite) => prerequisite.name).join(", ");
    let warning: string | null = null;
    if (later.length > 0) warning = `Needs ${names(later)}, which comes later in the queue.`;
    else if (missing.length > 0) {
      const skipped = missing.every((prerequisite) => prerequisite.status === "skipped");
      warning = `Needs ${names(missing)}, which you ${skipped ? "skipped" : "did not learn yet"}.`;
    }
    return {
      conceptId: row.id,
      slug: row.slug,
      name: row.name,
      objective: row.objective,
      kind: row.kind,
      level: row.level,
      module: { id: row.module_id, position: row.module_position, name: row.module_name },
      position: i + 1,
      prerequisites: own,
      warning,
    };
  });
  const suggestion = suggestedOrder(rows, prerequisites);
  return {
    theme: { slug: theme.slug, name: theme.name },
    items,
    suggestionDiffers: suggestion.some((id, i) => id !== rows[i]?.id),
  };
}

function writeOrder(db: Db, ids: number[]): void {
  const update = db.prepare("UPDATE concepts SET queue_pos = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, i) => update.run(i + 1, id)))();
}

// Set a new order. The list must contain each concept of the queue once.
export function reorderQueue(db: Db, slug: string, conceptIds: number[]): QueueView {
  const theme = themeOf(db, slug);
  const current = queueRows(db, theme.id).map((row) => row.id);
  const same = conceptIds.length === current.length && new Set(conceptIds).size === current.length && conceptIds.every((id) => current.includes(id));
  if (!same) throw new TutorError("The new order must contain each concept of the queue once. Load the queue again and try again.", 409);
  writeOrder(db, conceptIds);
  return queueView(db, slug);
}

export function applySuggestedOrder(db: Db, slug: string): QueueView {
  const theme = themeOf(db, slug);
  writeOrder(db, suggestedOrder(queueRows(db, theme.id), prerequisitesOf(db, theme.id)));
  return queueView(db, slug);
}

// Take a concept out of the queue: "skipped" skips it, and "new" keeps it for later.
export function removeFromQueue(db: Db, slug: string, conceptId: number, status: "skipped" | "new"): QueueView {
  const theme = themeOf(db, slug);
  const rows = queueRows(db, theme.id);
  if (!rows.some((row) => row.id === conceptId)) throw new TutorError(`The concept ${conceptId} is not in the study queue.`, 404);
  if (status !== "skipped" && status !== "new") throw new TutorError(`"${status}" is not a valid status.`);
  db.transaction(() => {
    db.prepare("UPDATE concepts SET status = ?, queue_pos = NULL WHERE id = ?").run(status, conceptId);
    writeOrder(db, rows.map((row) => row.id).filter((id) => id !== conceptId));
  })();
  return queueView(db, slug);
}

import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import type { QueueView } from "../src/server/api-types.js";
import { buildServer, type TutorServer } from "../src/server/app.js";
import { suggestedOrder } from "../src/tutor/queue.js";

let db: Db;
let app: TutorServer;
const ids: Record<string, number> = {};

// A theme with two modules. "joins" in module 2 is a prerequisite of "subqueries" in module 1.
function concept(slug: string, module: number, level: string, status: string, position: number | null) {
  ids[slug] = Number(
    db
      .prepare("INSERT INTO concepts (theme_id, module_id, slug, name, objective, kind, level, status, queue_pos) VALUES (1, ?, ?, ?, 'o', 'knowledge', ?, ?, ?)")
      .run(module, slug, slug.replace(/-/g, " "), level, status, position).lastInsertRowid,
  );
}
const prereq = (concept: string, needs: string) =>
  db.prepare("INSERT INTO concept_prereqs (concept_id, prereq_id) VALUES (?, ?)").run(ids[concept], ids[needs]);

beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO themes (slug, name) VALUES ('sql', 'SQL')").run();
  db.prepare("INSERT INTO modules (theme_id, position, name) VALUES (1, 1, 'Queries'), (1, 2, 'Joins')").run();
  concept("advanced-filter", 1, "advanced", "queued", 1);
  concept("subqueries", 1, "intermediate", "queued", 2);
  concept("joins", 2, "basic", "queued", 3);
  concept("select-basics", 1, "basic", "queued", 4);
  concept("group-by", 1, "basic", "new", null);
  concept("having", 1, "basic", "queued", 5);
  concept("where", 1, "basic", "known", null);
  prereq("subqueries", "joins");
  prereq("having", "group-by");
  prereq("select-basics", "where");
  app = buildServer({ db, dataDir: "data" });
});

const get = async () => (await app.inject({ method: "GET", url: "/api/themes/sql/queue" })).json<QueueView>();
const post = async <T>(url: string, body: unknown = {}) => {
  const response = await app.inject({ method: "POST", url, payload: body as object });
  return { status: response.statusCode, body: response.json<T>() };
};
const names = (view: QueueView) => view.items.map((item) => item.slug);

describe("study queue", () => {
  it("lists the queue in order, with warnings for prerequisites", async () => {
    const view = await get();
    expect(names(view)).toEqual(["advanced-filter", "subqueries", "joins", "select-basics", "having"]);
    const warning = (slug: string) => view.items.find((item) => item.slug === slug)!.warning;
    expect(warning("subqueries")).toEqual({
      kind: "later",
      prerequisites: [{ conceptId: ids["joins"], slug: "joins", name: "joins", status: "queued", module: { position: 2, name: "Joins" }, position: 3 }],
    });
    expect(warning("having")).toEqual({
      kind: "missing",
      prerequisites: [expect.objectContaining({ slug: "group-by", status: "new", module: { position: 1, name: "Queries" }, position: null })],
    });
    expect(warning("select-basics")).toBeNull();
    expect(view.suggestionDiffers).toBe(true);
  });

  it("gives the status of each concept and counts the concepts that are not chosen yet", async () => {
    db.prepare("UPDATE concepts SET status = 'learning' WHERE id = ?").run(ids["advanced-filter"]);
    const view = await get();
    expect(view.items.map((item) => item.status)).toEqual(["learning", "queued", "queued", "queued", "queued"]);
    expect(view.items[0]!.sources).toEqual([]);
    expect(view.notChosen).toEqual({ concepts: 1, modules: 1 });
  });

  it("applies the suggested order: prerequisites first, then modules, then levels", async () => {
    const { body } = await post<QueueView>("/api/themes/sql/queue/suggested");
    expect(names(body)).toEqual(["select-basics", "having", "advanced-filter", "joins", "subqueries"]);
    expect(body.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(body.items.find((item) => item.slug === "subqueries")!.warning).toBeNull();
    expect(body.suggestionDiffers).toBe(false);
  });

  it("sets an order of the learner, and rejects an order that does not match the queue", async () => {
    const order = [ids["having"]!, ids["joins"]!, ids["subqueries"]!, ids["select-basics"]!, ids["advanced-filter"]!];
    expect(names((await post<QueueView>("/api/themes/sql/queue/order", { conceptIds: order })).body)).toEqual([
      "having",
      "joins",
      "subqueries",
      "select-basics",
      "advanced-filter",
    ]);
    expect((await post("/api/themes/sql/queue/order", { conceptIds: order.slice(1) })).status).toBe(409);
  });

  it("skips a concept or keeps it for later, and closes the gap in the order", async () => {
    await post("/api/themes/sql/queue/remove", { conceptId: ids["subqueries"], status: "skipped" });
    const { body } = await post<QueueView>("/api/themes/sql/queue/remove", { conceptId: ids["joins"], status: "new" });
    expect(names(body)).toEqual(["advanced-filter", "select-basics", "having"]);
    expect(body.items.map((item) => item.position)).toEqual([1, 2, 3]);
    const status = (slug: string) => db.prepare("SELECT status FROM concepts WHERE id = ?").pluck().get(ids[slug]);
    expect(status("subqueries")).toBe("skipped");
    expect(status("joins")).toBe("new");
  });

  it("orders a cycle of prerequisites without a loop", () => {
    const row = (id: number, position: number) => ({
      id, slug: `c${id}`, name: `c${id}`, objective: "", kind: "knowledge" as const, level: "basic" as const,
      status: "queued" as const, queue_pos: position, module_id: 1, module_position: 1, module_name: "m",
    });
    const order = suggestedOrder([row(1, 1), row(2, 2)], new Map([[1, [{ id: 2 }]], [2, [{ id: 1 }]]]));
    expect(order.sort()).toEqual([1, 2]);
  });

  it("answers 404 for a theme that does not exist", async () => {
    expect((await app.inject({ method: "GET", url: "/api/themes/none/queue" })).statusCode).toBe(404);
  });
});

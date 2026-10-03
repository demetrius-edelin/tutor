import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

describe("openDb", () => {
  it("creates the schema and sets the version", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toContain("concepts");
    expect(tables).toContain("concept_sources");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("rejects a concept status that is not in the list", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO themes (slug, name) VALUES ('t', 'T')").run();
    db.prepare("INSERT INTO modules (theme_id, position, name) VALUES (1, 1, 'M')").run();
    const insert = db.prepare(
      "INSERT INTO concepts (theme_id, module_id, slug, name, objective, kind, level, status) VALUES (1, 1, 'c', 'C', 'o', 'knowledge', 'basic', ?)",
    );
    expect(() => insert.run("unknown")).toThrow(/CHECK/);
    expect(() => insert.run("queued")).not.toThrow();
  });
});

describe("migrations", () => {
  it("upgrades a version 1 database and keeps its data", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const file = join(mkdtempSync(join(tmpdir(), "tutor-db-")), "old.db");
    const old = new Database(file);
    old.exec(MIGRATIONS[0]!);
    old.pragma("user_version = 1");
    old.prepare("INSERT INTO themes (slug, name) VALUES ('sql', 'SQL')").run();
    old.close();

    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT name FROM themes").pluck().get()).toBe("SQL");
    expect(db.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(0);
  });

  it("keeps a lesson from version 3 as the detailed lesson", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const file = join(mkdtempSync(join(tmpdir(), "tutor-db-")), "old.db");
    const old = new Database(file);
    for (const migration of MIGRATIONS.slice(0, 3)) old.exec(migration);
    old.pragma("user_version = 3");
    old.prepare("INSERT INTO themes (slug, name) VALUES ('sql', 'SQL')").run();
    old.prepare("INSERT INTO modules (theme_id, position, name) VALUES (1, 1, 'Basics')").run();
    old
      .prepare("INSERT INTO concepts (theme_id, module_id, slug, name, objective, kind, level) VALUES (1, 1, 'like', 'LIKE', 'Use LIKE.', 'skill', 'basic')")
      .run();
    old.prepare("INSERT INTO lessons (concept_id, round, text, refs) VALUES (1, 1, 'A long lesson [1].', '[{\"number\":1}]')").run();
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT detail, detail_refs FROM lessons").get()).toEqual({ detail: "A long lesson [1].", detail_refs: '[{"number":1}]' });

    // Version 5 adds the star and removes the columns of the review schedule.
    const columns = db.prepare("SELECT name FROM pragma_table_info('concepts')").pluck().all();
    expect(columns).toContain("starred");
    expect(columns).not.toContain("review_step");
    expect(columns).not.toContain("review_at");
    expect(db.prepare("SELECT name, starred FROM concepts").get()).toEqual({ name: "LIKE", starred: 0 });
  });
});

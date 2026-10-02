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

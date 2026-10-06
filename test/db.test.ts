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
    db.prepare("INSERT INTO subjects (slug, name) VALUES ('t', 'T')").run();
    db.prepare("INSERT INTO modules (subject_id, position, name) VALUES (1, 1, 'M')").run();
    const insert = db.prepare(
      "INSERT INTO concepts (subject_id, module_id, slug, name, objective, kind, level, status) VALUES (1, 1, 'c', 'C', 'o', 'knowledge', 'basic', ?)",
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
    expect(db.prepare("SELECT name FROM subjects").pluck().get()).toBe("SQL");
    expect(db.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(0);
  });

  it("keeps a lesson from version 3, with its references", async () => {
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
    expect(db.prepare("SELECT text, refs FROM lessons").get()).toEqual({ text: "A long lesson [1].", refs: '[{"number":1}]' });

    // Version 5 adds the star and removes the columns of the review schedule.
    const columns = db.prepare("SELECT name FROM pragma_table_info('concepts')").pluck().all();
    expect(columns).toContain("starred");
    expect(columns).not.toContain("review_step");
    expect(columns).not.toContain("review_at");
    expect(db.prepare("SELECT name, starred FROM concepts").get()).toEqual({ name: "LIKE", starred: 0 });
  });

  it("replaces a short lesson with its detailed lesson in version 6", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const file = join(mkdtempSync(join(tmpdir(), "tutor-db-")), "old.db");
    const old = new Database(file);
    for (const migration of MIGRATIONS.slice(0, 5)) old.exec(migration);
    old.pragma("user_version = 5");
    old.prepare("INSERT INTO themes (slug, name) VALUES ('sql', 'SQL')").run();
    old.prepare("INSERT INTO modules (theme_id, position, name) VALUES (1, 1, 'Basics')").run();
    old
      .prepare("INSERT INTO concepts (theme_id, module_id, slug, name, objective, kind, level) VALUES (1, 1, 'like', 'LIKE', 'Use LIKE.', 'skill', 'basic')")
      .run();
    const insert = old.prepare("INSERT INTO lessons (concept_id, round, text, detail, detail_refs) VALUES (1, ?, ?, ?, ?)");
    insert.run(1, "Short.", "A long lesson [1].", '[{"number":1}]');
    insert.run(2, "Short, with no detail.", null, "[]");
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT text, refs FROM lessons ORDER BY round").all()).toEqual([
      { text: "A long lesson [1].", refs: '[{"number":1}]' },
      { text: "Short, with no detail.", refs: "[]" },
    ]);
    const columns = db.prepare("SELECT name FROM pragma_table_info('lessons')").pluck().all();
    expect(columns).not.toContain("detail");
    expect(columns).not.toContain("detail_refs");
  });

  it("removes the runner data in version 7 and keeps the subjects", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const file = join(mkdtempSync(join(tmpdir(), "tutor-db-")), "old.db");
    const old = new Database(file);
    for (const migration of MIGRATIONS.slice(0, 6)) old.exec(migration);
    old.pragma("user_version = 6");
    old.prepare("INSERT INTO themes (slug, name, runners) VALUES ('sql', 'SQL', '[\"sql\"]')").run();
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT slug, name FROM subjects").get()).toEqual({ slug: "sql", name: "SQL" });
    const columns = db.prepare("SELECT name FROM pragma_table_info('subjects')").pluck().all();
    expect(columns).not.toContain("runners");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).not.toContain("exercises");
  });

  it("renames the themes to subjects in version 8, with the data folder and the stored paths", async () => {
    const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const dataDir = mkdtempSync(join(tmpdir(), "tutor-db-"));
    const file = join(dataDir, "tutor.db");
    mkdirSync(join(dataDir, "themes", "sql", "books", "b", "sections"), { recursive: true });
    writeFileSync(join(dataDir, "themes", "sql", "books", "b", "sections", "01-01-a.md"), "# A");
    const old = new Database(file);
    for (const migration of MIGRATIONS.slice(0, 7)) old.exec(migration);
    old.pragma("user_version = 7");
    old.prepare("INSERT INTO themes (slug, name) VALUES ('sql', 'SQL')").run();
    old.prepare("INSERT INTO books (theme_id, slug, title, file) VALUES (1, 'b', 'B', 'themes/sql/books/b/b.epub')").run();
    old
      .prepare("INSERT INTO sections (book_id, chapter, number, chapter_title, title, path, words) VALUES (1, 1, 1, 'C', 'A', ?, 1)")
      .run("themes/sql/books/b/sections/01-01-a.md");
    old.prepare("INSERT INTO modules (theme_id, position, name) VALUES (1, 1, 'Basics')").run();
    old
      .prepare("INSERT INTO concepts (theme_id, module_id, slug, name, objective, kind, level) VALUES (1, 1, 'like', 'LIKE', 'Use LIKE.', 'skill', 'basic')")
      .run();
    const refs = JSON.stringify([{ sectionId: 1, path: "themes/sql/books/b/sections/01-01-a.md" }]);
    old.prepare("INSERT INTO lessons (concept_id, round, text, refs) VALUES (1, 1, 'A lesson [1].', ?)").run(refs);
    old.prepare("INSERT INTO lesson_messages (lesson_id, role, text, refs) VALUES (1, 'assistant', 'An answer [1].', ?)").run(refs);
    old.prepare("INSERT INTO sessions (theme_id, kind, status) VALUES (1, 'test', 'ready')").run();
    old.close();

    const db = openDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).toContain("subjects");
    expect(tables).not.toContain("themes");
    for (const table of ["books", "modules", "concepts", "sessions"]) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE subject_id = 1`).pluck().get()).toBe(1);
    }
    const newPath = "subjects/sql/books/b/sections/01-01-a.md";
    expect(db.prepare("SELECT file FROM books").pluck().get()).toBe("subjects/sql/books/b/b.epub");
    expect(db.prepare("SELECT path FROM sections").pluck().get()).toBe(newPath);
    expect(JSON.parse(db.prepare("SELECT refs FROM lessons").pluck().get() as string)[0].path).toBe(newPath);
    expect(JSON.parse(db.prepare("SELECT refs FROM lesson_messages").pluck().get() as string)[0].path).toBe(newPath);
    expect(existsSync(join(dataDir, newPath))).toBe(true);
    expect(existsSync(join(dataDir, "themes"))).toBe(false);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("stops if the themes folder and the subjects folder both exist", async () => {
    const { mkdirSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { MIGRATIONS } = await import("../src/db/schema.js");
    const dataDir = mkdtempSync(join(tmpdir(), "tutor-db-"));
    mkdirSync(join(dataDir, "themes"));
    mkdirSync(join(dataDir, "subjects"));
    const old = new Database(join(dataDir, "tutor.db"));
    for (const migration of MIGRATIONS.slice(0, 7)) old.exec(migration);
    old.pragma("user_version = 7");
    old.close();

    expect(() => openDb(join(dataDir, "tutor.db"))).toThrow(/both exist/);
  });
});

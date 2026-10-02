import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

// Use ":memory:" for tests.
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0) {
    db.transaction(() => {
      db.exec(SCHEMA);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(`Database schema version ${version} is not supported. Expected ${SCHEMA_VERSION}.`);
  }
  return db;
}

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

// Use ":memory:" for tests.
export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply the migrations that the database does not have yet, in order.
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(`The database has schema version ${version}. This version of the tutor knows only up to ${SCHEMA_VERSION}.`);
  }
  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next - 1]!);
      db.pragma(`user_version = ${next}`);
    })();
  }
  return db;
}

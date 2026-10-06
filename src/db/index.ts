import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, SUBJECTS_VERSION } from "./schema.js";

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
  if (file !== ":memory:" && version < SUBJECTS_VERSION) moveThemesFolder(dirname(file));
  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next - 1]!);
      db.pragma(`user_version = ${next}`);
    })();
  }
  return db;
}

// The migration to SUBJECTS_VERSION changes the stored paths from "themes/" to "subjects/".
// The folder moves before the migration. If the migration fails, the next start runs it again.
function moveThemesFolder(dataDir: string): void {
  const from = join(dataDir, "themes");
  const to = join(dataDir, "subjects");
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    throw new Error(`The folders ${from} and ${to} both exist. Move the content of ${from} into ${to}, then start again.`);
  }
  renameSync(from, to);
}

import { DatabaseSync } from "node:sqlite";
import { ALL_MIGRATIONS } from "./schema.js";

export function openStateDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  initializeStateDatabase(db);
  return db;
}

export function initializeStateDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");

  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();

  const currentVersion = existing
    ? ((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined)?.version ?? 0)
    : 0;

  if (currentVersion > ALL_MIGRATIONS.length) {
    throw new Error(`State database schema version ${currentVersion} is newer than supported version ${ALL_MIGRATIONS.length}.`);
  }

  for (let index = currentVersion; index < ALL_MIGRATIONS.length; index += 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(ALL_MIGRATIONS[index]!);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

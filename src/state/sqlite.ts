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

  if (!existing) {
    for (const migration of ALL_MIGRATIONS) {
      db.exec(migration);
    }
  }
}

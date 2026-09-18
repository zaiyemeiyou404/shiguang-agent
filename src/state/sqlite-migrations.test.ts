import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MIGRATION_001, SCHEMA_VERSION, type StateMigration } from "./schema.js";
import {
  initializeStateDatabase,
  UnsupportedStateDatabaseVersionError,
} from "./sqlite.js";

test("fresh databases apply every ordered migration and enable foreign keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const result = initializeStateDatabase(db);
    const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };

    assert.equal(result.initialVersion, 0);
    assert.equal(result.finalVersion, SCHEMA_VERSION);
    assert.deepEqual(result.appliedVersions, Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1));
    assert.equal(version.version, SCHEMA_VERSION);
    assert.equal(foreignKeys.foreign_keys, 1);
  } finally {
    db.close();
  }
});

test("version 1 upgrades preserve existing records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_001);
    db.prepare(`
      INSERT INTO sessions (id, title, status, created_at, updated_at, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-session", "Legacy", "active", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "kept");

    const result = initializeStateDatabase(db);
    const session = db.prepare("SELECT id, summary, workspace_id FROM sessions WHERE id = ?").get("legacy-session") as {
      id: string;
      summary: string;
      workspace_id: string;
    };

    assert.equal(result.initialVersion, 1);
    assert.equal(result.finalVersion, SCHEMA_VERSION);
    assert.equal(session.id, "legacy-session");
    assert.equal(session.summary, "kept");
    assert.ok(session.workspace_id);
  } finally {
    db.close();
  }
});

test("future-version databases are rejected without mutation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (999);");
    assert.throws(
      () => initializeStateDatabase(db),
      (error: unknown) => error instanceof UnsupportedStateDatabaseVersionError
        && error.databaseVersion === 999
        && error.supportedVersion === SCHEMA_VERSION,
    );
    const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(version.version, 999);
  } finally {
    db.close();
  }
});

test("a failed migration rolls back its schema and version update", () => {
  const db = new DatabaseSync(":memory:");
  const migrations: readonly StateMigration[] = [
    { version: 1, name: "base", sql: "CREATE TABLE marker (value TEXT NOT NULL);" },
    { version: 2, name: "broken", sql: "CREATE TABLE should_rollback (id INTEGER); INVALID SQL;" },
  ];
  try {
    assert.throws(() => initializeStateDatabase(db, { migrations }), /syntax|near/i);
    const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    const leakedTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback'").get();
    assert.equal(version.version, 1);
    assert.equal(leakedTable, undefined);
  } finally {
    db.close();
  }
});

test("destructive migrations create a verified queryable backup first", () => {
  const directory = mkdtempSync(join(tmpdir(), "shiguang-state-migration-"));
  const databasePath = join(directory, "state.db");
  const backupDirectory = join(directory, "backups");
  const db = new DatabaseSync(databasePath);
  const migrationsV1: readonly StateMigration[] = [
    { version: 1, name: "base", sql: "CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL);" },
  ];
  const migrationsV2: readonly StateMigration[] = [
    ...migrationsV1,
    { version: 2, name: "replace-record-layout", requiresBackup: true, sql: "ALTER TABLE records ADD COLUMN note TEXT;" },
  ];

  try {
    initializeStateDatabase(db, { migrations: migrationsV1, databasePath });
    db.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run("record-1", "preserved");

    const result = initializeStateDatabase(db, {
      migrations: migrationsV2,
      databasePath,
      backupDirectory,
      now: () => new Date("2026-09-18T01:02:03.000Z"),
    });

    assert.equal(result.finalVersion, 2);
    assert.equal(result.backupPaths.length, 1);
    assert.equal(existsSync(result.backupPaths[0]!), true);
    const backup = new DatabaseSync(result.backupPaths[0]!, { readOnly: true });
    try {
      const backupVersion = backup.prepare("SELECT version FROM schema_version").get() as { version: number };
      const record = backup.prepare("SELECT id, value FROM records WHERE id = ?").get("record-1") as { id: string; value: string };
      const noteColumn = backup.prepare("SELECT name FROM pragma_table_info('records') WHERE name = 'note'").get();
      assert.equal(backupVersion.version, 1);
      assert.equal(record.id, "record-1");
      assert.equal(record.value, "preserved");
      assert.equal(noteColumn, undefined);
    } finally {
      backup.close();
    }
    const primaryColumn = db.prepare("SELECT name FROM pragma_table_info('records') WHERE name = 'note'").get();
    assert.ok(primaryColumn);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration descriptors must be contiguous and ordered", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () => initializeStateDatabase(db, {
        migrations: [{ version: 2, name: "skips-one", sql: "SELECT 1;" }],
      }),
      /expected version 1, received 2/i,
    );
  } finally {
    db.close();
  }
});

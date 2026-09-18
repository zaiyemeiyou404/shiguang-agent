import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, STATE_MIGRATIONS, type StateMigration } from "./schema.js";

export interface StateMigrationOptions {
  migrations?: readonly StateMigration[];
  databasePath?: string;
  backupDirectory?: string;
  now?: () => Date;
}

export interface StateMigrationResult {
  initialVersion: number;
  finalVersion: number;
  appliedVersions: number[];
  backupPaths: string[];
}

export class UnsupportedStateDatabaseVersionError extends Error {
  constructor(readonly databaseVersion: number, readonly supportedVersion: number) {
    super(`State database schema version ${databaseVersion} is newer than supported version ${supportedVersion}.`);
    this.name = "UnsupportedStateDatabaseVersionError";
  }
}

export function openStateDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    initializeStateDatabase(db, { databasePath: path });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initializeStateDatabase(
  db: DatabaseSync,
  options: StateMigrationOptions = {},
): StateMigrationResult {
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = validateMigrations(options.migrations ?? STATE_MIGRATIONS);
  const supportedVersion = migrations.at(-1)?.version ?? 0;
  const initialVersion = readSchemaVersion(db);
  if (initialVersion > supportedVersion) {
    throw new UnsupportedStateDatabaseVersionError(initialVersion, supportedVersion);
  }

  let currentVersion = initialVersion;
  const appliedVersions: number[] = [];
  const backupPaths: string[] = [];
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    if (migration.requiresBackup) {
      backupPaths.push(createVerifiedDatabaseBackup(db, {
        databasePath: options.databasePath,
        backupDirectory: options.backupDirectory,
        fromVersion: currentVersion,
        toVersion: migration.version,
        now: options.now,
      }));
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      setSchemaVersion(db, migration.version);
      db.exec("COMMIT");
      currentVersion = migration.version;
      appliedVersions.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  if (foreignKeys?.foreign_keys !== 1) throw new Error("State database foreign key enforcement is disabled.");
  if (options.migrations === undefined && currentVersion !== SCHEMA_VERSION) {
    throw new Error(`State database migration ended at version ${currentVersion}; expected ${SCHEMA_VERSION}.`);
  }
  return { initialVersion, finalVersion: currentVersion, appliedVersions, backupPaths };
}

function readSchemaVersion(db: DatabaseSync): number {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!existing) return 0;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version?: number | null } | undefined;
  return typeof row?.version === "number" ? row.version : 0;
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  db.prepare("DELETE FROM schema_version").run();
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
}

function validateMigrations(migrations: readonly StateMigration[]): readonly StateMigration[] {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version !== previous + 1) {
      throw new Error(`State migrations must be contiguous and ordered; expected version ${previous + 1}, received ${migration.version}.`);
    }
    if (!migration.name.trim()) throw new Error(`State migration ${migration.version} must have a name.`);
    previous = migration.version;
  }
  return migrations;
}

function createVerifiedDatabaseBackup(
  db: DatabaseSync,
  input: {
    databasePath?: string;
    backupDirectory?: string;
    fromVersion: number;
    toVersion: number;
    now?: () => Date;
  },
): string {
  const rawDatabasePath = input.databasePath?.trim();
  if (!rawDatabasePath || rawDatabasePath === ":memory:") {
    throw new Error(`Migration to version ${input.toVersion} requires a file-backed database backup.`);
  }
  const databasePath = resolve(rawDatabasePath);
  if (!existsSync(databasePath)) {
    throw new Error(`Migration to version ${input.toVersion} requires a file-backed database backup.`);
  }
  const backupDirectory = resolve(input.backupDirectory ?? join(dirname(databasePath), "backups"));
  mkdirSync(backupDirectory, { recursive: true });
  const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = join(
    backupDirectory,
    `${basename(databasePath)}.v${input.fromVersion}-before-v${input.toVersion}-${stamp}.bak`,
  );
  db.exec(`VACUUM INTO '${escapeSqliteLiteral(backupPath)}'`);

  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error(`Backup integrity check failed for ${backupPath}.`);
    const backupVersion = readSchemaVersion(backup);
    if (backupVersion !== input.fromVersion) {
      throw new Error(`Backup schema version ${backupVersion} did not match expected version ${input.fromVersion}.`);
    }
  } finally {
    backup.close();
  }
  return backupPath;
}

function escapeSqliteLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

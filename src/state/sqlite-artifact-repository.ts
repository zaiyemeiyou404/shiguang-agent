import type { DatabaseSync } from "node:sqlite";
import type { Artifact } from "../core/types.js";
import type { ArtifactRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type ArtifactRow = {
  id: string;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  kind: string;
  uri: string;
  title: string | null;
  metadata_json: string | null;
  created_at: string;
};

const ARTIFACT_COLUMNS = `
  id,
  session_id,
  task_id,
  run_id,
  kind,
  uri,
  title,
  metadata_json,
  created_at
`;

export class SqliteArtifactRepository implements ArtifactRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(artifact: Artifact): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO artifacts (
          id,
          session_id,
          task_id,
          run_id,
          kind,
          uri,
          title,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.sessionId,
        artifact.taskId,
        artifact.runId,
        artifact.kind,
        artifact.uri,
        artifact.title,
        JSON.stringify(artifact.metadata ?? {}),
        toSqlDate(artifact.createdAt),
      );
  }

  async listByTask(taskId: string): Promise<Artifact[]> {
    const rows = this.db
      .prepare(`
        SELECT ${ARTIFACT_COLUMNS}
        FROM artifacts
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
      `)
      .all(taskId) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  async listBySession(sessionId: string): Promise<Artifact[]> {
    const rows = this.db
      .prepare(`
        SELECT ${ARTIFACT_COLUMNS}
        FROM artifacts
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
      `)
      .all(sessionId) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    uri: row.uri,
    title: row.title,
    metadata: parseMetadata(row.metadata_json),
    createdAt: new Date(row.created_at),
  };
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function toSqlDate(date: Date): string {
  return date.toISOString();
}

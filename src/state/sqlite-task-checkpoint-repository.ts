import type { DatabaseSync } from "node:sqlite";
import type { TaskCheckpoint } from "../core/types.js";
import type { TaskCheckpointRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type TaskCheckpointRow = {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: TaskCheckpoint["kind"];
  title: string;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
};

const COLUMNS = "id, task_id, run_id, kind, title, summary, payload_json, created_at";

export class SqliteTaskCheckpointRepository implements TaskCheckpointRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(checkpoint: TaskCheckpoint): Promise<void> {
    this.db.prepare(`
      INSERT INTO task_checkpoints (id, task_id, run_id, kind, title, summary, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.taskId,
      checkpoint.runId,
      checkpoint.kind,
      checkpoint.title,
      checkpoint.summary,
      JSON.stringify(checkpoint.payload ?? {}),
      checkpoint.createdAt.toISOString(),
    );
  }

  async listByTask(taskId: string): Promise<TaskCheckpoint[]> {
    const rows = this.db.prepare(`
      SELECT ${COLUMNS} FROM task_checkpoints
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(taskId) as TaskCheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  async latestByTask(taskId: string): Promise<TaskCheckpoint | null> {
    const row = this.db.prepare(`
      SELECT ${COLUMNS} FROM task_checkpoints
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(taskId) as TaskCheckpointRow | undefined;
    return row ? rowToCheckpoint(row) : null;
  }
}

function rowToCheckpoint(row: TaskCheckpointRow): TaskCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    payload: parsePayload(row.payload_json),
    createdAt: new Date(row.created_at),
  };
}

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

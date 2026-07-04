import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Run } from "../core/types.js";
import type { RunRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type RunRow = {
  id: string;
  session_id: string;
  task_id: string;
  status: Run["status"];
  reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  model: string | null;
  summary: string | null;
};

const RUN_COLUMNS = `
  id,
  session_id,
  task_id,
  status,
  reason,
  started_at,
  ended_at,
  model,
  summary
`;

const PATCH_COLUMNS = {
  sessionId: "session_id",
  taskId: "task_id",
  status: "status",
  reason: "reason",
  startedAt: "started_at",
  endedAt: "ended_at",
  model: "model",
  summary: "summary",
} as const satisfies Partial<Record<keyof Run, string>>;

export class SqliteRunRepository implements RunRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(run: Run): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO runs (
          id,
          session_id,
          task_id,
          status,
          reason,
          started_at,
          ended_at,
          model,
          summary
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.sessionId,
        run.taskId,
        run.status,
        run.reason,
        toSqlDate(run.startedAt),
        toSqlDate(run.endedAt),
        run.model,
        run.summary,
      );
  }

  async get(id: string): Promise<Run | null> {
    const row = this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async update(id: string, patch: Partial<Run>): Promise<void> {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];

    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<
      [keyof typeof PATCH_COLUMNS, string]
    >) {
      if (field in patch && patch[field] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(toSqlValue(patch[field]));
      }
    }

    if (assignments.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async listByTask(taskId: string): Promise<Run[]> {
    const rows = this.db
      .prepare(`
        SELECT ${RUN_COLUMNS}
        FROM runs
        WHERE task_id = ?
        ORDER BY COALESCE(started_at, '') DESC, id DESC
      `)
      .all(taskId) as RunRow[];
    return rows.map(rowToRun);
  }

  async listBySession(sessionId: string): Promise<Run[]> {
    const rows = this.db
      .prepare(`
        SELECT ${RUN_COLUMNS}
        FROM runs
        WHERE session_id = ?
        ORDER BY COALESCE(started_at, '') DESC, id DESC
      `)
      .all(sessionId) as RunRow[];
    return rows.map(rowToRun);
  }
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    status: row.status,
    reason: row.reason,
    startedAt: fromSqlDate(row.started_at),
    endedAt: fromSqlDate(row.ended_at),
    model: row.model,
    summary: row.summary,
  };
}

function toSqlValue(value: Run[keyof Run] | undefined): SQLInputValue {
  if (value === undefined) return null;
  return value instanceof Date ? toSqlDate(value) : value;
}

function toSqlDate(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function fromSqlDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

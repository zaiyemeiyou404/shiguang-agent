import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Task } from "../core/types.js";
import type { TaskRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type TaskRow = {
  id: string;
  session_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: Task["status"];
  priority: number;
  created_at: string;
  updated_at: string;
};

const TASK_COLUMNS = `
  id,
  session_id,
  parent_task_id,
  title,
  description,
  status,
  priority,
  created_at,
  updated_at
`;

const PATCH_COLUMNS = {
  sessionId: "session_id",
  parentTaskId: "parent_task_id",
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies Partial<Record<keyof Task, string>>;

export class SqliteTaskRepository implements TaskRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(task: Task): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO tasks (
          id,
          session_id,
          parent_task_id,
          title,
          description,
          status,
          priority,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.sessionId,
        task.parentTaskId,
        task.title,
        task.description,
        task.status,
        task.priority,
        toSqlDate(task.createdAt),
        toSqlDate(task.updatedAt),
      );
  }

  async get(id: string): Promise<Task | null> {
    const row = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  async update(id: string, patch: Partial<Task>): Promise<void> {
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
    this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async listBySession(sessionId: string): Promise<Task[]> {
    const rows = this.db
      .prepare(`
        SELECT ${TASK_COLUMNS}
        FROM tasks
        WHERE session_id = ?
        ORDER BY updated_at DESC, id DESC
      `)
      .all(sessionId) as TaskRow[];
    return rows.map(rowToTask);
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toSqlValue(value: Task[keyof Task] | undefined): SQLInputValue {
  if (value === undefined) return null;
  return value instanceof Date ? toSqlDate(value) : value;
}

function toSqlDate(date: Date): string {
  return date.toISOString();
}

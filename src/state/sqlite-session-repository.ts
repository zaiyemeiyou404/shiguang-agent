import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Session } from "../core/types.js";
import type { SessionRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type SessionRow = {
  id: string;
  title: string;
  status: Session["status"];
  created_at: string;
  updated_at: string;
  summary: string | null;
};

const SESSION_COLUMNS = `
  id,
  title,
  status,
  created_at,
  updated_at,
  summary
`;

const PATCH_COLUMNS = {
  title: "title",
  status: "status",
  createdAt: "created_at",
  updatedAt: "updated_at",
  summary: "summary",
} as const satisfies Partial<Record<keyof Session, string>>;

export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(session: Session): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO sessions (
          id,
          title,
          status,
          created_at,
          updated_at,
          summary
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.title,
        session.status,
        toSqlDate(session.createdAt),
        toSqlDate(session.updatedAt),
        session.summary,
      );
  }

  async get(id: string): Promise<Session | null> {
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  async update(id: string, patch: Partial<Session>): Promise<void> {
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
    this.db.prepare(`UPDATE sessions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async list(limit = 100, offset = 0): Promise<Session[]> {
    const rows = this.db
      .prepare(`
        SELECT ${SESSION_COLUMNS}
        FROM sessions
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?
      `)
      .all(normalizeLimit(limit), normalizeOffset(offset)) as SessionRow[];
    return rows.map(rowToSession);
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    summary: row.summary,
  };
}

function toSqlValue(value: Session[keyof Session] | undefined): SQLInputValue {
  if (value === undefined) return null;
  return value instanceof Date ? toSqlDate(value) : value;
}

function toSqlDate(date: Date): string {
  return date.toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

function normalizeOffset(offset: number): number {
  return Math.max(0, Math.trunc(offset));
}

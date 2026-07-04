import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Approval, ApprovalStatus } from "../core/types.js";
import type { ApprovalRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type ApprovalRow = {
  id: string;
  run_id: string;
  plugin_id: string;
  capability: string;
  status: string;
  request_json: string;
  decided_at: string | null;
};

const APPROVAL_COLUMNS = `
  id,
  run_id,
  plugin_id,
  capability,
  status,
  request_json,
  decided_at
`;

const PATCH_COLUMNS: Record<string, string> = {
  status: "status",
  decidedAt: "decided_at",
};

export class SqliteApprovalRepository implements ApprovalRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(approval: Approval): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO approvals (
          id,
          run_id,
          plugin_id,
          capability,
          status,
          request_json,
          decided_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId,
        approval.pluginId,
        approval.capability,
        approval.status,
        JSON.stringify(approval.request ?? {}),
        toSqlDate(approval.decidedAt),
      );
  }

  async update(id: string, patch: Partial<Approval>): Promise<void> {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];

    for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(toSqlValue(value));
      }
    }

    if (assignments.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE approvals SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async listPending(runId: string): Promise<Approval[]> {
    const rows = this.db
      .prepare(`
        SELECT ${APPROVAL_COLUMNS}
        FROM approvals
        WHERE run_id = ? AND status = 'pending'
        ORDER BY id ASC
      `)
      .all(runId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async listBySession(sessionId: string): Promise<Approval[]> {
    const rows = this.db
      .prepare(`
        SELECT a.id AS id, a.run_id AS run_id, a.plugin_id AS plugin_id,
               a.capability AS capability, a.status AS status,
               a.request_json AS request_json, a.decided_at AS decided_at
        FROM approvals a
        JOIN runs r ON r.id = a.run_id
        WHERE r.session_id = ? AND a.status = 'pending'
        ORDER BY a.id ASC
      `)
      .all(sessionId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    pluginId: row.plugin_id,
    capability: row.capability,
    status: row.status as ApprovalStatus,
    request: parseRequestJson(row.request_json),
    decidedAt: fromSqlDate(row.decided_at),
  };
}

function parseRequestJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return toSqlDate(value);
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  return null;
}

function toSqlDate(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function fromSqlDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

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
  scope: "once" | "task" | "workspace";
};

const APPROVAL_COLUMNS = `
  id,
  run_id,
  plugin_id,
  capability,
  status,
  request_json,
  decided_at,
  scope
`;

const PATCH_COLUMNS: Record<string, string> = {
  status: "status",
  decidedAt: "decided_at",
  scope: "scope",
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
          decided_at,
          scope
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId,
        approval.pluginId,
        approval.capability,
        approval.status,
        JSON.stringify(approval.request ?? {}),
        toSqlDate(approval.decidedAt),
        approval.scope ?? "once",
      );
  }

  async get(id: string): Promise<Approval | null> {
    const row = this.db
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`)
      .get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
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
               a.request_json AS request_json, a.decided_at AS decided_at, a.scope AS scope
        FROM approvals a
        JOIN runs r ON r.id = a.run_id
        WHERE r.session_id = ? AND a.status = 'pending'
        ORDER BY a.id ASC
      `)
      .all(sessionId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async listReusableBySession(sessionId: string): Promise<Approval[]> {
    const rows = this.db.prepare(`
      SELECT a.id AS id, a.run_id AS run_id, a.plugin_id AS plugin_id,
             a.capability AS capability, a.status AS status,
             a.request_json AS request_json, a.decided_at AS decided_at, a.scope AS scope
      FROM approvals a
      JOIN runs r ON r.id = a.run_id
      JOIN sessions source_session ON source_session.id = r.session_id
      JOIN sessions requested_session ON requested_session.id = ?
      WHERE a.status = 'granted' AND a.scope = 'workspace'
        AND source_session.workspace_id = requested_session.workspace_id
      ORDER BY a.decided_at DESC, a.id DESC
    `).all(sessionId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async findReusable(runId: string, capability: string): Promise<Approval | null> {
    const row = this.db
      .prepare(`
        SELECT a.id AS id, a.run_id AS run_id, a.plugin_id AS plugin_id,
               a.capability AS capability, a.status AS status,
               a.request_json AS request_json, a.decided_at AS decided_at, a.scope AS scope
        FROM approvals a
        JOIN runs source_run ON source_run.id = a.run_id
        JOIN sessions source_session ON source_session.id = source_run.session_id
        JOIN runs requested_run ON requested_run.id = ?
        JOIN sessions requested_session ON requested_session.id = requested_run.session_id
        WHERE a.status = 'granted'
          AND a.capability = ?
          AND a.scope IN ('task', 'workspace')
          AND a.run_id <> ?
          AND (
            (a.scope = 'task' AND source_run.task_id = requested_run.task_id)
            OR (a.scope = 'workspace' AND source_session.workspace_id = requested_session.workspace_id)
          )
        ORDER BY a.decided_at DESC, a.id DESC
        LIMIT 1
      `)
      .get(runId, capability, runId) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
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
    scope: row.scope,
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

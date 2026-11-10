import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../core/types.js";
import type { SessionRepository } from "./repositories.js";

export interface StoredSessionLlm {
  provider?: string;
  model?: string;
  maxTokens?: number;
}

export interface StoredDesktopSession {
  id: string;
  workspaceId: string;
  title: string;
  status: Session["status"];
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  workspaceRoot: string | null;
  llm: StoredSessionLlm | null;
}

interface SessionStateRow {
  id: string;
  workspace_id: string;
  title: string;
  status: Session["status"];
  created_at: string;
  updated_at: string;
  summary: string | null;
  workspace_root: string | null;
  llm_json: string | null;
  listed: number | null;
}

const SESSION_STATE_SQL = `
  SELECT
    s.id,
    s.workspace_id,
    s.title,
    s.status,
    s.created_at,
    s.updated_at,
    s.summary,
    d.workspace_root,
    d.llm_json,
    d.listed
  FROM sessions s
  LEFT JOIN session_desktop_state d ON d.session_id = s.id
`;

export class SessionRecords {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sessions: SessionRepository,
  ) {}

  async listVisible(): Promise<StoredDesktopSession[]> {
    const rows = this.db.prepare(`
      ${SESSION_STATE_SQL}
      WHERE COALESCE(d.listed, 1) = 1
      ORDER BY s.created_at ASC, s.id ASC
    `).all() as unknown as SessionStateRow[];
    return rows.map(rowToStoredSession);
  }

  async get(id: string): Promise<StoredDesktopSession | null> {
    const row = this.db.prepare(`${SESSION_STATE_SQL} WHERE s.id = ?`).get(id) as unknown as SessionStateRow | undefined;
    if (!row || row.listed === 0) return null;
    return rowToStoredSession(row);
  }

  async create(session: StoredDesktopSession): Promise<StoredDesktopSession> {
    await this.sessions.create(toCoreSession(session));
    this.writeState(session, 1);
    return session;
  }

  async update(id: string, patch: Partial<StoredDesktopSession>): Promise<StoredDesktopSession | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: StoredDesktopSession = { ...current, ...patch, id: current.id, workspaceId: current.workspaceId };
    await this.sessions.update(id, {
      title: next.title,
      status: next.status,
      summary: next.summary,
      updatedAt: new Date(next.updatedAt),
    });
    this.writeState(next, 1);
    return next;
  }

  async removeFromList(id: string): Promise<boolean> {
    const existing = await this.sessions.get(id);
    if (!existing) return false;
    const visible = await this.get(id);
    if (!visible) return false;
    const updatedAt = new Date();
    await this.sessions.update(id, { status: "archived", updatedAt });
    this.writeState({
      ...visible,
      status: "archived",
      updatedAt: updatedAt.toISOString(),
    }, 0);
    return true;
  }

  private writeState(session: StoredDesktopSession, listed: 0 | 1): void {
    this.db.prepare(`
      INSERT INTO session_desktop_state (session_id, workspace_root, llm_json, listed)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        llm_json = excluded.llm_json,
        listed = excluded.listed
    `).run(
      session.id,
      session.workspaceRoot,
      session.llm ? JSON.stringify(session.llm) : null,
      listed,
    );
  }
}

export function rowToStoredSession(row: SessionStateRow): StoredDesktopSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    createdAt: sqlDateToIso(row.created_at),
    updatedAt: sqlDateToIso(row.updated_at),
    summary: row.summary,
    workspaceRoot: row.workspace_root,
    llm: parseStoredLlm(row.llm_json),
  };
}

function toCoreSession(session: StoredDesktopSession): Session {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    status: session.status,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    summary: session.summary,
  };
}

function sqlDateToIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseStoredLlm(value: string | null): StoredSessionLlm | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
      ...(typeof record.model === "string" ? { model: record.model } : {}),
      ...(typeof record.maxTokens === "number" ? { maxTokens: record.maxTokens } : {}),
    };
  } catch {
    return null;
  }
}

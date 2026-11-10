import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "./schema.js";
import type { StoredSessionLlm } from "./session-records.js";

export const DESKTOP_SESSION_AUTHORITY_KEY = "desktop-session-authority-v1";

export interface AuthoritySession {
  id: string;
  workspaceId?: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  workspaceRoot?: string | null;
  llm?: StoredSessionLlm | null;
}

/**
 * One-time handoff from the JSON desktop store to SQLite.
 * JSON was the list the UI read, so a non-empty snapshot wins once.
 * An empty snapshot does not hide SQLite sessions: a failed store read must not erase them.
 */
export function adoptDesktopSessionAuthority(db: DatabaseSync, sessions: readonly AuthoritySession[]): void {
  const marker = db.prepare("SELECT source_key FROM legacy_runtime_imports WHERE source_key = ?")
    .get(DESKTOP_SESSION_AUTHORITY_KEY);
  if (marker) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (sessions.length > 0) {
      const visibleIds = new Set<string>();
      for (const session of sessions) {
        if (upsertAuthoritySession(db, session)) visibleIds.add(session.id);
      }
      const rows = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
      for (const row of rows) {
        if (!visibleIds.has(row.id)) hideAuthoritySession(db, row.id);
      }
    }
    db.prepare(`
      INSERT INTO legacy_runtime_imports (source_key, completed_at, result_json)
      VALUES (?, ?, ?)
    `).run(DESKTOP_SESSION_AUTHORITY_KEY, new Date().toISOString(), JSON.stringify({ sessions: sessions.length }));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function upsertAuthoritySession(db: DatabaseSync, session: AuthoritySession): boolean {
  const workspaceId = session.workspaceId || DEFAULT_WORKSPACE_ID;
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) return false;
  const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id);
  if (!existing) {
    db.prepare(`
      INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, workspaceId, session.title, session.status, session.createdAt, session.updatedAt, session.summary);
  } else {
    db.prepare(`
      UPDATE sessions
      SET title = ?, status = ?, summary = ?, created_at = ?, updated_at = ?
      WHERE id = ?
    `).run(session.title, session.status, session.summary, session.createdAt, session.updatedAt, session.id);
  }
  db.prepare(`
    INSERT INTO session_desktop_state (session_id, workspace_root, llm_json, listed)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      workspace_root = excluded.workspace_root,
      llm_json = excluded.llm_json,
      listed = 1
  `).run(session.id, session.workspaceRoot ?? null, session.llm ? JSON.stringify(session.llm) : null);
  return true;
}

function hideAuthoritySession(db: DatabaseSync, sessionId: string): void {
  db.prepare(`
    INSERT INTO session_desktop_state (session_id, workspace_root, llm_json, listed)
    VALUES (?, NULL, NULL, 0)
    ON CONFLICT(session_id) DO UPDATE SET listed = 0
  `).run(sessionId);
}

import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "./schema.js";

export interface LegacyRuntimeSession {
  id: string;
  workspaceId?: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
}

export interface LegacyRuntimeRun {
  id: string;
  sessionId: string;
  status: string;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  budget?: { maxSteps: number; stepsUsed: number } | null;
}

export interface LegacyRuntimeEvent {
  id: string;
  runId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface LegacyRuntimeData {
  sessions: LegacyRuntimeSession[];
  runs: LegacyRuntimeRun[];
  events: LegacyRuntimeEvent[];
}

export interface LegacyImportConflict {
  entity: "session" | "task" | "run" | "event";
  id: string;
  reason: string;
}

export interface LegacyImportReport {
  sourceKey: string;
  completedAt: string;
  imported: { sessions: number; tasks: number; runs: number; events: number };
  skipped: { sessions: number; tasks: number; runs: number; events: number };
  conflicts: LegacyImportConflict[];
  alreadyCompleted: boolean;
}

export function importLegacyRuntimeData(
  db: DatabaseSync,
  data: LegacyRuntimeData,
  options: { sourceKey?: string; now?: () => Date } = {},
): LegacyImportReport {
  const sourceKey = options.sourceKey?.trim() || "desktop-store-v1";
  const marker = db.prepare("SELECT result_json FROM legacy_runtime_imports WHERE source_key = ?").get(sourceKey) as
    | { result_json: string }
    | undefined;
  if (marker) {
    return { ...(JSON.parse(marker.result_json) as LegacyImportReport), alreadyCompleted: true };
  }

  const report: LegacyImportReport = {
    sourceKey,
    completedAt: (options.now?.() ?? new Date()).toISOString(),
    imported: { sessions: 0, tasks: 0, runs: 0, events: 0 },
    skipped: { sessions: 0, tasks: 0, runs: 0, events: 0 },
    conflicts: [],
    alreadyCompleted: false,
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const session of data.sessions) importSession(db, session, report);
    for (const run of data.runs) importRunAndTask(db, run, data.sessions, report);
    for (const event of data.events) importEvent(db, event, report);
    db.prepare(`
      INSERT INTO legacy_runtime_imports (source_key, completed_at, result_json)
      VALUES (?, ?, ?)
    `).run(sourceKey, report.completedAt, JSON.stringify(report));
    db.exec("COMMIT");
    return report;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function importSession(db: DatabaseSync, session: LegacyRuntimeSession, report: LegacyImportReport): void {
  const workspaceId = session.workspaceId || DEFAULT_WORKSPACE_ID;
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
  if (!workspace) {
    addConflict(report, "session", session.id, `workspace does not exist: ${workspaceId}`);
    report.skipped.sessions += 1;
    return;
  }
  const existing = db.prepare("SELECT id, workspace_id, title, status, created_at, updated_at, summary FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown> | undefined;
  if (existing) {
    report.skipped.sessions += 1;
    if (existing.workspace_id !== workspaceId || existing.title !== session.title || existing.status !== session.status) {
      addConflict(report, "session", session.id, "existing SQLite record differs from legacy data");
    }
    return;
  }
  db.prepare(`
    INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, workspaceId, session.title, session.status, session.createdAt, session.updatedAt, session.summary);
  report.imported.sessions += 1;
}

function importRunAndTask(
  db: DatabaseSync,
  run: LegacyRuntimeRun,
  sessions: readonly LegacyRuntimeSession[],
  report: LegacyImportReport,
): void {
  const parent = db.prepare("SELECT id, created_at FROM sessions WHERE id = ?").get(run.sessionId) as { id: string; created_at: string } | undefined;
  if (!parent) {
    addConflict(report, "run", run.id, `session does not exist: ${run.sessionId}`);
    report.skipped.runs += 1;
    return;
  }
  const taskId = `legacy-task:${run.id}`;
  const existingTask = db.prepare("SELECT id, session_id FROM tasks WHERE id = ?").get(taskId) as { id: string; session_id: string } | undefined;
  if (!existingTask) {
    const sourceSession = sessions.find((session) => session.id === run.sessionId);
    const timestamp = run.startedAt || sourceSession?.createdAt || parent.created_at;
    db.prepare(`
      INSERT INTO tasks (id, session_id, parent_task_id, title, description, status, priority, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)
    `).run(taskId, run.sessionId, `Imported run ${run.id}`, "Imported from the legacy desktop runtime store.", taskStatusForRun(run.status), timestamp, run.endedAt || timestamp);
    report.imported.tasks += 1;
  } else {
    report.skipped.tasks += 1;
    if (existingTask.session_id !== run.sessionId) addConflict(report, "task", taskId, "existing task belongs to another session");
  }

  const existingRun = db.prepare("SELECT id, session_id, task_id, status FROM runs WHERE id = ?").get(run.id) as Record<string, unknown> | undefined;
  if (existingRun) {
    report.skipped.runs += 1;
    if (existingRun.session_id !== run.sessionId || existingRun.task_id !== taskId || existingRun.status !== run.status) {
      addConflict(report, "run", run.id, "existing SQLite record differs from legacy data");
    }
    return;
  }
  db.prepare(`
    INSERT INTO runs (id, session_id, task_id, status, reason, started_at, ended_at, model, summary, budget_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(run.id, run.sessionId, taskId, run.status, run.reason, run.startedAt, run.endedAt, run.summary, JSON.stringify(run.budget ?? {}));
  report.imported.runs += 1;
}

function importEvent(db: DatabaseSync, event: LegacyRuntimeEvent, report: LegacyImportReport): void {
  const run = db.prepare("SELECT id FROM runs WHERE id = ?").get(event.runId);
  if (!run) {
    addConflict(report, "event", event.id, `run does not exist: ${event.runId}`);
    report.skipped.events += 1;
    return;
  }
  const existing = db.prepare("SELECT id, run_id, seq, kind, payload_json FROM run_events WHERE id = ?").get(event.id) as Record<string, unknown> | undefined;
  if (existing) {
    report.skipped.events += 1;
    if (existing.run_id !== event.runId || existing.seq !== event.seq || existing.kind !== event.kind) {
      addConflict(report, "event", event.id, "existing SQLite record differs from legacy data");
    }
    return;
  }
  db.prepare(`
    INSERT INTO run_events (id, run_id, seq, kind, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(event.id, event.runId, event.seq, event.kind, JSON.stringify(event.payload ?? null), event.createdAt);
  report.imported.events += 1;
}

function addConflict(report: LegacyImportReport, entity: LegacyImportConflict["entity"], id: string, reason: string): void {
  report.conflicts.push({ entity, id, reason });
}

function taskStatusForRun(status: string): string {
  if (status === "needs_approval") return "waiting_approval";
  if (status === "paused") return "blocked";
  return status;
}

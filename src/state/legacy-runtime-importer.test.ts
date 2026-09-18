import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { importLegacyRuntimeData, type LegacyRuntimeData } from "./legacy-runtime-importer.js";
import { DEFAULT_WORKSPACE_ID } from "./schema.js";
import { initializeStateDatabase } from "./sqlite.js";

const legacyData: LegacyRuntimeData = {
  sessions: [{
    id: "legacy-session",
    workspaceId: DEFAULT_WORKSPACE_ID,
    title: "Legacy session",
    status: "active",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:03:00.000Z",
    summary: "legacy summary",
  }],
  runs: [{
    id: "legacy-run",
    sessionId: "legacy-session",
    status: "completed",
    reason: null,
    startedAt: "2026-09-17T00:01:00.000Z",
    endedAt: "2026-09-17T00:02:00.000Z",
    summary: "done",
    budget: { maxSteps: 8, stepsUsed: 3 },
  }],
  events: [{
    id: "legacy-event",
    runId: "legacy-run",
    seq: 1,
    kind: "message",
    payload: { text: "done" },
    createdAt: "2026-09-17T00:02:00.000Z",
  }],
};

test("legacy runtime import is durable and idempotent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeStateDatabase(db);
    const first = importLegacyRuntimeData(db, legacyData, {
      sourceKey: "test-store",
      now: () => new Date("2026-09-18T00:00:00.000Z"),
    });
    const stateAfterFirst = runtimeRows(db);
    const second = importLegacyRuntimeData(db, legacyData, { sourceKey: "test-store" });
    const stateAfterSecond = runtimeRows(db);

    assert.deepEqual(first.imported, { sessions: 1, tasks: 1, runs: 1, events: 1 });
    assert.equal(first.alreadyCompleted, false);
    assert.equal(second.alreadyCompleted, true);
    assert.deepEqual(stateAfterSecond, stateAfterFirst);
    assert.equal(stateAfterSecond["markers"]!.length, 1);
    assert.equal(stateAfterSecond["tasks"]![0]?.id, "legacy-task:legacy-run");
  } finally {
    db.close();
  }
});

test("legacy runtime import reports conflicts without overwriting SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeStateDatabase(db);
    db.prepare(`
      INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-session",
      DEFAULT_WORKSPACE_ID,
      "SQLite wins",
      "active",
      "2026-09-16T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
      null,
    );

    const report = importLegacyRuntimeData(db, legacyData, { sourceKey: "conflict-store" });
    const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get("legacy-session") as { title: string };

    assert.equal(session.title, "SQLite wins");
    assert.equal(report.skipped.sessions, 1);
    assert.deepEqual(report.conflicts[0], {
      entity: "session",
      id: "legacy-session",
      reason: "existing SQLite record differs from legacy data",
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM legacy_runtime_imports").get()?.count, 1);
  } finally {
    db.close();
  }
});

function runtimeRows(db: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  return {
    sessions: db.prepare("SELECT * FROM sessions WHERE id = 'legacy-session'").all() as Array<Record<string, unknown>>,
    tasks: db.prepare("SELECT * FROM tasks WHERE id = 'legacy-task:legacy-run'").all() as Array<Record<string, unknown>>,
    runs: db.prepare("SELECT * FROM runs WHERE id = 'legacy-run'").all() as Array<Record<string, unknown>>,
    events: db.prepare("SELECT * FROM run_events WHERE id = 'legacy-event'").all() as Array<Record<string, unknown>>,
    markers: db.prepare("SELECT * FROM legacy_runtime_imports WHERE source_key = 'test-store'").all() as Array<Record<string, unknown>>,
  };
}

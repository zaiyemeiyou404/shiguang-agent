import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "./schema.js";
import { initializeStateDatabase } from "./sqlite.js";
import { SqliteApprovalRepository } from "./sqlite-approval-repository.js";
import { SqliteArtifactRepository } from "./sqlite-artifact-repository.js";
import { SqliteRunEventRepository } from "./sqlite-run-event-repository.js";
import { SqliteRunRepository } from "./sqlite-run-repository.js";
import { SqliteSessionRepository } from "./sqlite-session-repository.js";
import { SqliteTaskRepository } from "./sqlite-task-repository.js";
import { SqliteTurnRepository } from "./sqlite-turn-repository.js";

test("SQLite repositories support the desktop session and run lifecycle", async () => {
  const db = new DatabaseSync(":memory:");
  initializeStateDatabase(db);
  const sessions = new SqliteSessionRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const turns = new SqliteTurnRepository(db);
  const runs = new SqliteRunRepository(db);
  const events = new SqliteRunEventRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const artifacts = new SqliteArtifactRepository(db);
  const createdAt = new Date("2026-09-18T02:00:00.000Z");
  const updatedAt = new Date("2026-09-18T02:01:00.000Z");

  try {
    await sessions.create({
      id: "session-1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: "Initial title",
      status: "active",
      createdAt,
      updatedAt: createdAt,
      summary: null,
    });
    await sessions.update("session-1", { title: "Renamed", summary: "1 run(s)", updatedAt });
    assert.equal((await sessions.get("session-1"))?.title, "Renamed");
    assert.deepEqual((await sessions.list()).map((session) => session.id), ["session-1"]);

    await tasks.create({
      id: "task-1",
      sessionId: "session-1",
      parentTaskId: null,
      title: "Desktop task",
      description: "exercise repositories",
      status: "pending",
      priority: 1,
      createdAt,
      updatedAt: createdAt,
    });
    await tasks.update("task-1", { status: "running", updatedAt });
    assert.equal((await tasks.get("task-1"))?.status, "running");
    assert.deepEqual((await tasks.listBySession("session-1")).map((task) => task.id), ["task-1"]);

    await turns.create({ id: "turn-user", sessionId: "session-1", role: "user", content: "Start", createdAt });
    await turns.create({ id: "turn-assistant", sessionId: "session-1", role: "assistant", content: "Done", createdAt: updatedAt });
    assert.deepEqual((await turns.listBySession("session-1", 20)).map((turn) => turn.id), ["turn-user", "turn-assistant"]);

    await runs.create({
      id: "run-1",
      sessionId: "session-1",
      taskId: "task-1",
      status: "pending",
      reason: null,
      startedAt: null,
      endedAt: null,
      model: "test-model",
      summary: null,
      budget: { maxSteps: 8, stepsUsed: 0 },
    });
    await runs.update("run-1", { status: "needs_approval", startedAt: createdAt, budget: { maxSteps: 8, stepsUsed: 1 } });
    assert.equal((await runs.get("run-1"))?.status, "needs_approval");
    assert.deepEqual((await runs.listBySession("session-1")).map((run) => run.id), ["run-1"]);
    assert.deepEqual((await runs.listByTask("task-1")).map((run) => run.id), ["run-1"]);

    await events.create({ id: "event-2", runId: "run-1", seq: 2, kind: "message", payload: { text: "later" }, createdAt: updatedAt });
    await events.create({ id: "event-1", runId: "run-1", seq: 1, kind: "approval_request", payload: { approvalId: "approval-1" }, createdAt });
    assert.deepEqual((await events.listByRun("run-1")).map((event) => event.seq), [1, 2]);

    await approvals.create({
      id: "approval-1",
      runId: "run-1",
      pluginId: "builtin",
      capability: "write_text_file",
      status: "pending",
      request: { path: "README.md" },
      decidedAt: null,
      scope: "once",
    });
    assert.equal((await approvals.listPending("run-1"))[0]?.id, "approval-1");
    assert.equal((await approvals.listBySession("session-1"))[0]?.id, "approval-1");
    await approvals.update("approval-1", { status: "granted", decidedAt: updatedAt });
    assert.equal((await approvals.get("approval-1"))?.status, "granted");
    assert.equal((await approvals.listPending("run-1")).length, 0);

    await artifacts.create({
      id: "artifact-1",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      kind: "result",
      uri: "file:///result.txt",
      title: "Result",
      metadata: { source: "test" },
      createdAt: updatedAt,
    });
    assert.equal((await artifacts.listByTask("task-1"))[0]?.id, "artifact-1");
    assert.equal((await artifacts.listBySession("session-1"))[0]?.metadata?.source, "test");
  } finally {
    db.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeStateDatabase } from "./sqlite.js";
import { SqliteTaskCheckpointRepository } from "./sqlite-task-checkpoint-repository.js";

test("task checkpoints persist in order and expose the latest recovery point", async () => {
  const db = new DatabaseSync(":memory:");
  initializeStateDatabase(db);
  const now = new Date("2026-09-18T00:00:00.000Z");
  db.prepare("INSERT INTO sessions (id, workspace_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("session_1", "workspace_default", "Session", "active", now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO tasks (id, session_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("task_1", "session_1", "Task", "planned", 0, now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO runs (id, session_id, task_id, status) VALUES (?, ?, ?, ?)")
    .run("run_1", "session_1", "task_1", "pending");

  const checkpoints = new SqliteTaskCheckpointRepository(db);
  await checkpoints.create({
    id: "checkpoint_1", taskId: "task_1", runId: null, kind: "planned", title: "Task planned", summary: null,
    payload: { nextStep: "Inspect files" }, createdAt: now,
  });
  await checkpoints.create({
    id: "checkpoint_2", taskId: "task_1", runId: "run_1", kind: "waiting_user", title: "Need workspace", summary: "Choose a workspace",
    payload: { reason: "workspace_missing" }, createdAt: new Date("2026-09-18T00:01:00.000Z"),
  });

  assert.deepEqual((await checkpoints.listByTask("task_1")).map((item) => item.id), ["checkpoint_1", "checkpoint_2"]);
  assert.equal((await checkpoints.latestByTask("task_1"))?.kind, "waiting_user");
  db.close();
});

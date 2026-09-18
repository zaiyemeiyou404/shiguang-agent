import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Run } from "../core/types.js";
import { InMemoryEventSink } from "./event-sink.js";
import { RuntimeCoordinator, type RunStore } from "./coordinator.js";

class TestRunStore implements RunStore {
  readonly run: Run = {
    id: "run_1",
    sessionId: "session_1",
    taskId: "task_1",
    status: "pending",
    reason: null,
    startedAt: null,
    endedAt: null,
    model: null,
    summary: null,
  };

  async getRun(id: string): Promise<Run | null> {
    return id === this.run.id ? this.run : null;
  }

  async updateRun(id: string, patch: Partial<Run>): Promise<void> {
    assert.equal(id, this.run.id);
    Object.assign(this.run, patch);
  }
}

test("RuntimeCoordinator persists pause, approval, user wait, verification, block, and resume states", async () => {
  const store = new TestRunStore();
  const sink = new InMemoryEventSink();
  const coordinator = new RuntimeCoordinator(store, sink);

  await coordinator.handle({ type: "start", runId: "run_1", model: "model-a" });
  await coordinator.handle({ type: "pause", runId: "run_1", reason: "user paused" });
  assert.equal(store.run.status, "paused");
  assert.equal(store.run.reason, "user paused");

  await coordinator.handle({ type: "wait_for_approval", runId: "run_1", reason: "write access" });
  assert.equal(store.run.status, "needs_approval");
  await coordinator.handle({ type: "wait_for_user", runId: "run_1", reason: "choose a workspace" });
  assert.equal(store.run.status, "waiting_user");
  await coordinator.handle({ type: "resume", runId: "run_1", model: "model-b" });
  assert.equal(store.run.status, "running");
  assert.equal(store.run.reason, null);
  assert.equal(store.run.model, "model-b");

  await coordinator.handle({ type: "verify", runId: "run_1" });
  assert.equal(store.run.status, "verifying");
  await coordinator.handle({ type: "block", runId: "run_1", reason: "budget exhausted" });
  assert.equal(store.run.status, "blocked");
  assert.equal(store.run.reason, "budget exhausted");
  assert.ok(store.run.endedAt instanceof Date);

  const events = await sink.list("run_1");
  assert.equal(events.map((event) => event.seq).join(","), "1,2,3,4,5,6,7");
});

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { ContextService } from "./service.js";
import type { ContextBuilderInput } from "./builder.js";
import type { Run, Task } from "../core/types.js";

function makeTask(): Task {
  return {
    id: "task-1",
    sessionId: "session-1",
    parentTaskId: null,
    title: "Test task",
    description: null,
    status: "in_progress",
    priority: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeRun(index: number, summary: string): Run {
  return {
    id: `run-${index}`,
    sessionId: "session-1",
    taskId: "task-1",
    status: "completed",
    reason: null,
    startedAt: new Date(`2026-01-01T0${index}:00:00.000Z`),
    endedAt: new Date(`2026-01-01T0${index}:30:00.000Z`),
    model: "test-model",
    summary,
  };
}

function makeInput(summarySeed = "keep this recent run summary"): ContextBuilderInput {
  return {
    userTurn: "continue",
    task: makeTask(),
    recentRuns: Array.from({ length: 5 }, (_, index) => makeRun(index + 1, `${summarySeed} ${index + 1}`)),
    linkedArtifacts: [],
    memories: [],
  };
}

test("ContextService leaves small contexts uncompressed below the pressure threshold", async () => {
  const service = new ContextService({ maxBudget: 8192 });

  const { bundle, diagnostics } = await service.build(makeInput());

  assert.equal(diagnostics.compression.compressionTriggered, false);
  assert.equal(diagnostics.compression.compressedCount, 0);
  assert.equal(bundle.volatile.some((item) => item.kind === "run_digest"), false);
  assert.equal(bundle.volatile.filter((item) => item.kind === "run_summary").length, 5);
});

test("ContextService only enters deterministic compression under high budget pressure", async () => {
  const service = new ContextService({
    maxBudget: 64,
    compressionOptions: { minBudgetPressure: 0.5, maxRunSummaryItems: 1 },
  });
  const longSummary = "important prior work with enough detail to create pressure ".repeat(16);

  const { diagnostics } = await service.build(makeInput(longSummary));

  assert.equal(diagnostics.compression.compressionTriggered, true);
  assert.ok((diagnostics.compression.budgetPressure ?? 0) >= 0.5);
});

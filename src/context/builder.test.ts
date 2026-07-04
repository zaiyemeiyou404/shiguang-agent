import { test } from "node:test";
import * as assert from "node:assert/strict";

import { trimToBudget } from "./builder.js";
import type { ContextBundle, ContextItem } from "./types.js";

function makeItem(overrides: Partial<ContextItem> & Pick<ContextItem, "id" | "kind" | "layer" | "source" | "content">): ContextItem {
  return {
    id: overrides.id,
    kind: overrides.kind,
    layer: overrides.layer,
    source: overrides.source,
    content: overrides.content,
    metadata: overrides.metadata,
    provenance: overrides.provenance ?? {
      source: overrides.source,
      retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      method: "direct",
    },
    score: overrides.score ?? 0.5,
    budget: overrides.budget ?? 1,
  };
}

function makeBundle(optional: ContextItem[]): ContextBundle {
  const stable = [
    makeItem({ id: "stable-task", kind: "task_state", layer: "stable", source: "task:t1", content: "task", budget: 1, score: 1 }),
  ];
  const volatile = [
    makeItem({ id: "user-turn", kind: "user_turn", layer: "volatile", source: "session", content: "hello", budget: 1, score: 1 }),
    ...optional.filter(item => item.layer === "volatile"),
  ];
  const live = optional.filter(item => item.layer === "live");
  return {
    stable,
    volatile,
    live,
    totalBudget: [...stable, ...volatile, ...live].reduce((sum, item) => sum + item.budget, 0),
    builtAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

test("trimToBudget keeps digest items before ordinary optional items", () => {
  const digest = makeItem({
    id: "run-digest",
    kind: "run_digest",
    layer: "volatile",
    source: "compress:run_summaries",
    content: "digest",
    score: 0.2,
    budget: 3,
  });
  const artifact = makeItem({
    id: "artifact-high-score",
    kind: "artifact",
    layer: "volatile",
    source: "artifact:a1",
    content: "artifact",
    score: 0.95,
    budget: 3,
  });

  const trimmed = trimToBudget(makeBundle([artifact, digest]), 5);

  assert.deepEqual(trimmed.volatile.map(item => item.kind), ["user_turn", "run_digest"]);
});

test("trimToBudget prefers recent high-signal run summaries over older normal runs", () => {
  const olderCompletedRun = makeItem({
    id: "run-old-completed",
    kind: "run_summary",
    layer: "volatile",
    source: "run:old",
    content: "[completed] old run",
    score: 0.95,
    budget: 3,
    metadata: {
      status: "completed",
      endedAt: "2026-01-01T09:00:00.000Z",
    },
  });
  const recentFailedRun = makeItem({
    id: "run-recent-failed",
    kind: "run_summary",
    layer: "volatile",
    source: "run:new",
    content: "[failed] new run",
    score: 0.8,
    budget: 3,
    metadata: {
      status: "failed",
      endedAt: "2026-01-01T10:00:00.000Z",
    },
  });

  const trimmed = trimToBudget(makeBundle([olderCompletedRun, recentFailedRun]), 5);

  assert.deepEqual(trimmed.volatile.map(item => item.source), ["session", "run:new"]);
});

test("trimToBudget keeps workspace file_ref before ordinary memory when budget is tight", () => {
  const memory = makeItem({
    id: "memory-high-score",
    kind: "memory",
    layer: "volatile",
    source: "memory:m1",
    content: "important memory",
    score: 0.95,
    budget: 2,
  });
  const fileRef = makeItem({
    id: "workspace-ref",
    kind: "file_ref",
    layer: "live",
    source: "/repo",
    content: "workspace: /repo",
    score: 0.3,
    budget: 2,
  });

  const trimmed = trimToBudget(makeBundle([memory, fileRef]), 4);

  assert.equal(trimmed.live.length, 1);
  assert.equal(trimmed.live[0]?.kind, "file_ref");
  assert.deepEqual(trimmed.volatile.map(item => item.kind), ["user_turn"]);
});

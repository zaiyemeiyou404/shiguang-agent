import { test } from "node:test";
import * as assert from "node:assert/strict";

import { compressContextBundle } from "./compress.js";
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

function makeBundle(items: ContextItem[]): ContextBundle {
  const stable = [
    makeItem({
      id: "task",
      kind: "task_state",
      layer: "stable",
      source: "task:t1",
      content: "task",
      budget: 1,
      score: 1,
    }),
  ];
  const volatile = [...items];
  const live: ContextItem[] = [];
  return {
    stable,
    volatile,
    live,
    totalBudget: [...stable, ...volatile].reduce((sum, item) => sum + item.budget, 0),
    builtAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

test("compressContextBundle skips run digests that would grow the token budget", () => {
  const bundle = makeBundle([
    makeItem({ id: "user", kind: "user_turn", layer: "volatile", source: "session", content: "hi", budget: 1, score: 1 }),
    makeItem({
      id: "run-1",
      kind: "run_summary",
      layer: "volatile",
      source: "run:1",
      content: "[completed] short",
      budget: 3,
      score: 0.7,
      metadata: { status: "completed", endedAt: "2026-01-01T09:00:00.000Z" },
    }),
    makeItem({
      id: "run-2",
      kind: "run_summary",
      layer: "volatile",
      source: "run:2",
      content: "[completed] tiny",
      budget: 3,
      score: 0.7,
      metadata: { status: "completed", endedAt: "2026-01-01T10:00:00.000Z" },
    }),
  ]);

  const compressed = compressContextBundle(bundle, { maxRunSummaryItems: 1 });

  assert.equal(compressed.totalBudget, bundle.totalBudget);
  assert.equal(compressed.volatile.some((item) => item.kind === "run_digest"), false);
  assert.equal(compressed.volatile.filter((item) => item.kind === "run_summary").length, 2);
});

test("compressContextBundle skips memory digests that would grow the token budget", () => {
  const bundle = makeBundle([
    makeItem({ id: "user", kind: "user_turn", layer: "volatile", source: "session", content: "hi", budget: 1, score: 1 }),
    makeItem({ id: "mem-1", kind: "memory", layer: "volatile", source: "memory:1", content: "alpha", budget: 2, score: 0.9 }),
    makeItem({ id: "mem-2", kind: "memory", layer: "volatile", source: "memory:2", content: "beta", budget: 2, score: 0.8 }),
    makeItem({ id: "mem-3", kind: "memory", layer: "volatile", source: "memory:3", content: "gamma", budget: 2, score: 0.7 }),
  ]);

  const compressed = compressContextBundle(bundle, { maxMemoryItems: 1 });

  assert.equal(compressed.totalBudget, bundle.totalBudget);
  assert.equal(compressed.volatile.some((item) => item.kind === "memory_digest"), false);
  assert.equal(compressed.volatile.filter((item) => item.kind === "memory").length, 3);
});

test("compressContextBundle skips artifact digests that would grow the token budget", () => {
  const bundle = makeBundle([
    makeItem({ id: "user", kind: "user_turn", layer: "volatile", source: "session", content: "hi", budget: 1, score: 1 }),
    makeItem({ id: "art-1", kind: "artifact", layer: "volatile", source: "file://a", content: "[note] a", budget: 2, score: 0.6 }),
    makeItem({ id: "art-2", kind: "artifact", layer: "volatile", source: "file://b", content: "[note] b", budget: 2, score: 0.5 }),
    makeItem({ id: "art-3", kind: "artifact", layer: "volatile", source: "file://c", content: "[note] c", budget: 2, score: 0.4 }),
  ]);

  const compressed = compressContextBundle(bundle, { maxArtifactItems: 1 });

  assert.equal(compressed.totalBudget, bundle.totalBudget);
  assert.equal(compressed.volatile.some((item) => item.kind === "artifact_digest"), false);
  assert.equal(compressed.volatile.filter((item) => item.kind === "artifact").length, 3);
});

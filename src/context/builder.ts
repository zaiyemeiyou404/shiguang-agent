import type { ContextItem, ContextBundle, ContextLayer } from "./types.js";
import type { Task, Run, Artifact } from "../core/types.js";

export interface ContextBuilderInput {
  userTurn: string;
  task: Task;
  recentRuns: Run[];
  linkedArtifacts: Artifact[];
  memories: { id: string; content: string; summary?: string; confidence: number }[];
  systemInstructions?: string;
  workspaceRoot?: string;
}

let seq = 0;
function nextId(): string {
  return `ctx_${Date.now()}_${++seq}`;
}

function makeItem(
  kind: ContextItem["kind"],
  layer: ContextLayer,
  source: string,
  content: string,
  score: number,
  method: ContextItem["provenance"]["method"],
  metadata?: ContextItem["metadata"],
): ContextItem {
  return {
    id: nextId(),
    kind,
    layer,
    source,
    content,
    metadata,
    provenance: { source, retrievedAt: new Date(), method },
    score,
    budget: estimateTokens(content),
  };
}

export function buildContext(input: ContextBuilderInput): ContextBundle {
  const stable: ContextItem[] = [];
  const volatile: ContextItem[] = [];
  const live: ContextItem[] = [];
  const now = new Date();

  if (input.systemInstructions) {
    stable.push(
      makeItem("system_instruction", "stable", "system", input.systemInstructions, 1, "direct"),
    );
  }

  stable.push(
    makeItem("task_state", "stable", `task:${input.task.id}`,
      `[${input.task.status}] ${input.task.title}${input.task.description ? `\n${input.task.description}` : ""}`,
      0.95, "direct"),
  );

  volatile.push(
    makeItem("user_turn", "volatile", "session", input.userTurn, 1, "direct"),
  );

  for (const run of input.recentRuns.slice(0, 5)) {
    if (!run.summary) continue;
    const runScore = run.status === "failed"
      ? 0.9
      : run.status === "cancelled" || run.status === "needs_approval"
        ? 0.8
        : 0.7;
    volatile.push(
      makeItem("run_summary", "volatile", `run:${run.id}`,
        `[${run.status}] ${run.summary}`, runScore, "direct", {
          runId: run.id,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          endedAt: run.endedAt?.toISOString() ?? null,
        }),
    );
  }

  for (const art of input.linkedArtifacts.slice(0, 10)) {
    volatile.push(
      makeItem("artifact", "volatile", art.uri,
        `[${art.kind}] ${art.title ?? art.uri}`, 0.5, "linked"),
    );
  }

  for (const mem of input.memories.slice(0, 8)) {
    const label = mem.summary ?? mem.content.slice(0, 80);
    volatile.push(
      makeItem("memory", "volatile", `memory:${mem.id}`,
        label, mem.confidence, "query"),
    );
  }

  if (input.workspaceRoot) {
    live.push(
      makeItem("file_ref", "live", input.workspaceRoot,
        `workspace: ${input.workspaceRoot}`, 0.3, "direct"),
    );
  }

  const all = [...stable, ...volatile, ...live];
  const totalBudget = all.reduce((s, i) => s + i.budget, 0);

  return { stable, volatile, live, totalBudget, builtAt: now };
}

export function trimToBudget(bundle: ContextBundle, maxBudget: number): ContextBundle {
  const all = [...bundle.stable, ...bundle.volatile, ...bundle.live];
  if (all.reduce((s, i) => s + i.budget, 0) <= maxBudget) return bundle;

  const mustKeep = all.filter(i => i.layer === "stable" || i.kind === "user_turn");
  const optional = all
    .filter(i => !mustKeep.includes(i))
    .sort(compareOptionalContextItems);

  const kept: ContextItem[] = [...mustKeep];
  let used = mustKeep.reduce((s, i) => s + i.budget, 0);
  for (const item of optional) {
    if (used + item.budget <= maxBudget) {
      kept.push(item);
      used += item.budget;
    }
  }
  const stable = kept.filter(i => i.layer === "stable");
  const volatile = kept.filter(i => i.layer === "volatile");
  const live = kept.filter(i => i.layer === "live");
  return { stable, volatile, live, totalBudget: used, builtAt: bundle.builtAt };
}

const digestKinds = new Set<ContextItem["kind"]>([
  "run_digest",
  "memory_digest",
  "artifact_digest",
  "context_digest",
]);

function compareOptionalContextItems(a: ContextItem, b: ContextItem): number {
  return compareNumber(optionalPriority(b), optionalPriority(a))
    || compareNumber(runStatusBonus(b), runStatusBonus(a))
    || compareNumber(runTimestamp(b), runTimestamp(a))
    || compareNumber(b.score, a.score)
    || compareText(a.kind, b.kind)
    || compareText(a.source, b.source)
    || compareText(a.content, b.content);
}

function optionalPriority(item: ContextItem): number {
  if (digestKinds.has(item.kind)) return 4;
  if (item.kind === "run_summary") return 3;
  if (item.layer === "live" && item.kind === "file_ref") return 2;
  return 1;
}

function runStatusBonus(item: ContextItem): number {
  if (item.kind !== "run_summary") return 0;
  const status = item.metadata?.status;
  return status === "failed" || status === "cancelled" || status === "needs_approval" ? 1 : 0;
}

function runTimestamp(item: ContextItem): number {
  if (item.kind !== "run_summary") return 0;
  return Math.max(metadataTime(item, "endedAt"), metadataTime(item, "startedAt"));
}

function metadataTime(item: ContextItem, key: string): number {
  const value = item.metadata?.[key];
  if (typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a - b;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

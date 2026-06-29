import type { ContextItem, ContextBundle } from "./types.js";
import type { Task, Run, Artifact } from "../core/types.js";

export interface ContextBuilderInput {
  userTurn: string;
  task: Task;
  recentRuns: Run[];
  linkedArtifacts: Artifact[];
  memories: { id: string; content: string; confidence: number }[];
  systemInstructions?: string;
}

let seq = 0;
function nextId(): string {
  return `ctx_${Date.now()}_${++seq}`;
}

export function buildContext(input: ContextBuilderInput): ContextBundle {
  const items: ContextItem[] = [];
  const now = new Date();

  if (input.systemInstructions) {
    items.push({
      id: nextId(),
      kind: "system_instruction",
      source: "system",
      content: input.systemInstructions,
      provenance: { source: "system", retrievedAt: now, method: "direct" },
      score: 1,
      budget: estimateTokens(input.systemInstructions),
    });
  }

  items.push({
    id: nextId(),
    kind: "user_turn",
    source: "session",
    content: input.userTurn,
    provenance: { source: "user", retrievedAt: now, method: "direct" },
    score: 1,
    budget: estimateTokens(input.userTurn),
  });

  items.push({
    id: nextId(),
    kind: "task_state",
    source: `task:${input.task.id}`,
    content: `[${input.task.status}] ${input.task.title}${
      input.task.description ? `\n${input.task.description}` : ""
    }`,
    provenance: { source: `task:${input.task.id}`, retrievedAt: now, method: "direct" },
    score: 0.95,
    budget: estimateTokens(input.task.title + (input.task.description ?? "")),
  });

  for (const run of input.recentRuns.slice(0, 5)) {
    if (!run.summary) continue;
    items.push({
      id: nextId(),
      kind: "run_summary",
      source: `run:${run.id}`,
      content: `[${run.status}] ${run.summary}`,
      provenance: { source: `run:${run.id}`, retrievedAt: now, method: "direct" },
      score: 0.7,
      budget: estimateTokens(run.summary),
    });
  }

  for (const art of input.linkedArtifacts.slice(0, 10)) {
    items.push({
      id: nextId(),
      kind: "artifact",
      source: art.uri,
      content: `[${art.kind}] ${art.title ?? art.uri}`,
      provenance: { source: art.uri, retrievedAt: now, method: "linked" },
      score: 0.5,
      budget: estimateTokens(art.title ?? art.uri),
    });
  }

  for (const mem of input.memories.slice(0, 8)) {
    items.push({
      id: nextId(),
      kind: "memory",
      source: `memory:${mem.id}`,
      content: mem.content,
      provenance: { source: `memory:${mem.id}`, retrievedAt: now, method: "query" },
      score: mem.confidence,
      budget: estimateTokens(mem.content),
    });
  }

  items.sort((a, b) => b.score - a.score);
  const totalBudget = items.reduce((s, i) => s + i.budget, 0);

  return { items, totalBudget, builtAt: now };
}

export function trimToBudget(bundle: ContextBundle, maxBudget: number): ContextBundle {
  if (bundle.totalBudget <= maxBudget) return bundle;
  const kept: ContextItem[] = [];
  let used = 0;
  for (const item of bundle.items) {
    if (used + item.budget <= maxBudget) {
      kept.push(item);
      used += item.budget;
    }
  }
  return { items: kept, totalBudget: used, builtAt: bundle.builtAt };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

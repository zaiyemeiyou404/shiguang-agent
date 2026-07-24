export type ContextLayer = "stable" | "volatile" | "live";

export type ContextItemKind =
  | "user_turn"
  | "task_state"
  | "memory"
  | "artifact"
  | "file_ref"
  | "plugin_ref"
  | "run_summary"
  | "system_instruction"
  | "context_digest"
  | "memory_digest"
  | "artifact_digest"
  | "run_digest";

export interface CompressionStats {
  originalItemCount: number;
  originalBudget: number;
  prunedCount: number;
  compressedCount: number;
  finalBudget: number;
  compressionTriggered?: boolean;
  budgetPressure?: number;
  maxBudget?: number;
}

export interface CompressionOptions {
  maxRunSummaryItems?: number;
  maxMemoryItems?: number;
  maxArtifactItems?: number;
  minBudgetPressure?: number;
}

export interface Provenance {
  source: string;
  retrievedAt: Date;
  method: "direct" | "query" | "linked" | "plugin";
}

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  layer: ContextLayer;
  source: string;
  content: string;
  metadata?: Record<string, unknown>;
  provenance: Provenance;
  score: number;
  budget: number;
}

export interface ContextBundle {
  stable: ContextItem[];
  volatile: ContextItem[];
  live: ContextItem[];
  totalBudget: number;
  builtAt: Date;
}

export interface RenderedPrompt {
  system: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  refs: Array<{ kind: ContextItemKind; source: string; uri?: string }>;
}

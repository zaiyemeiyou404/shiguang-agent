export type ContextItemKind =
  | "user_turn"
  | "task_state"
  | "memory"
  | "artifact"
  | "file_ref"
  | "plugin_ref"
  | "run_summary"
  | "system_instruction";

export interface Provenance {
  source: string;
  retrievedAt: Date;
  method: "direct" | "query" | "linked" | "plugin";
}

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  source: string;
  content: string;
  provenance: Provenance;
  score: number;
  budget: number;
}

export interface ContextBundle {
  items: ContextItem[];
  totalBudget: number;
  builtAt: Date;
}

import type { ContextBundle } from "../context/types.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface BrainInput {
  context: ContextBundle;
  runId: string;
  history: ActionResult[];
  availableTools: ToolDescriptor[];
}

export type BrainActionKind = "respond" | "tool_call" | "finish" | "fail";

export interface BrainAction {
  kind: BrainActionKind;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  reason?: string;
}

export interface BrainDecision {
  action: BrainAction;
  reasoning?: string;
}

export interface ActionResult {
  action: BrainAction;
  ok: boolean;
  output: unknown;
  error?: string;
}

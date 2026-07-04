import type { ContextBundle } from "../context/types.js";
import type { Turn } from "../core/types.js";
import type { ToolDescriptor, ValidationModeHint } from "../tools/types.js";

export interface BrainInput {
  context: ContextBundle;
  runId: string;
  priorTurns: Turn[];
  history: ActionResult[];
  workingMemory?: WorkingMemorySnapshot;
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

export interface WorkingMemorySnapshot {
  step: number;
  lastActionKind: BrainActionKind | null;
  lastToolName?: string;
  lastObservation?: {
    category: ActionResultCategory;
    summary: string;
  };
  validationFailure?: {
    mode: ValidationModeHint;
    failingCommands: string[];
    summary: string;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    suspectFile?: string;
    suspectLine?: number;
    suspectColumn?: number;
    suspectErrorCode?: string;
    suspectImportPath?: string;
    suspectImportStyle?: string;
    suspectExportName?: string;
    failingTestName?: string;
    assertExpected?: string;
    assertActual?: string;
    assertDiffSummary?: string;
  };
  retryableToolErrors?: {
    toolName: string;
    count: number;
  };
}

export interface ActionResult {
  action: BrainAction;
  ok: boolean;
  output: unknown;
  error?: string;
  metadata?: ActionResultMetadata;
}

export type ActionResultCategory =
  | "assistant_response"
  | "agent_finish"
  | "tool_observation"
  | "tool_error"
  | "runtime_error";

export type ToolErrorKind =
  | "invalid_input"
  | "permission_denied"
  | "auth_required"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "not_found"
  | "conflict"
  | "tool_missing"
  | "unknown";

export interface ActionResultMetadata {
  category: ActionResultCategory;
  summary: string;
  retryable?: boolean;
  toolName?: string;
  errorType?: string;
  errorKind?: ToolErrorKind;
  workspaceMutation?: boolean;
  validationMode?: ValidationModeHint;
}

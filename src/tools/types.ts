export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects?: ToolEffects;
  risk?: ToolRisk;
  requiresApproval?: boolean;
  capability?: string;
  contract?: ToolContract;
}

export interface ToolApprovalPreview {
  kind: "text_diff" | "summary";
  title: string;
  path?: string;
  operation?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  warnings?: string[];
}

export type ValidationModeHint = "typecheck" | "test" | "build" | "all";
export type ToolRisk = "read" | "write" | "execute";
export type ToolContractSource = "native" | "mcp-adapter";
export type ToolContractCategory =
  | "filesystem"
  | "workspace"
  | "code"
  | "diagnostics"
  | "process"
  | "git"
  | "github"
  | "web"
  | "memory"
  | "system"
  | "mcp";
export type ToolContractPhase =
  | "inspect"
  | "read"
  | "plan"
  | "edit"
  | "execute"
  | "verify"
  | "summarize";
export type ToolApprovalMode = "never" | "on_risk" | "always";
export type ToolCostClass = "low" | "medium" | "high";

export interface ToolEffects {
  workspaceMutation?: boolean;
  validationMode?: ValidationModeHint;
}

export interface ToolContract {
  version: "shiguang.tool.contract.v1";
  source: ToolContractSource;
  category: ToolContractCategory;
  phase: ToolContractPhase;
  risk: ToolRisk;
  approval: ToolApprovalMode;
  cost: ToolCostClass;
  effects: ToolEffects;
  recommendedBeforeTools: string[];
  recommendedAfterTools: string[];
  completionSignals: string[];
  maxPromptChars?: number;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface Tool {
  descriptor: ToolDescriptor;
  previewApproval?(input: unknown, context?: ToolExecutionContext): Promise<ToolApprovalPreview | null> | ToolApprovalPreview | null;
  execute(input: unknown, context?: ToolExecutionContext): Promise<unknown>;
}

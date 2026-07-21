export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects?: ToolEffects;
  risk?: ToolRisk;
  requiresApproval?: boolean;
  capability?: string;
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

export interface ToolEffects {
  workspaceMutation?: boolean;
  validationMode?: ValidationModeHint;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface Tool {
  descriptor: ToolDescriptor;
  previewApproval?(input: unknown, context?: ToolExecutionContext): Promise<ToolApprovalPreview | null> | ToolApprovalPreview | null;
  execute(input: unknown, context?: ToolExecutionContext): Promise<unknown>;
}

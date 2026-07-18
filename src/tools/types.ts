export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects?: ToolEffects;
  risk?: ToolRisk;
  requiresApproval?: boolean;
  capability?: string;
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
  execute(input: unknown, context?: ToolExecutionContext): Promise<unknown>;
}

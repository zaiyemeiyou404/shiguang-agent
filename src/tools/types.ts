export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects?: ToolEffects;
}

export type ValidationModeHint = "typecheck" | "test" | "build" | "all";

export interface ToolEffects {
  workspaceMutation?: boolean;
  validationMode?: ValidationModeHint;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: unknown): Promise<unknown>;
}

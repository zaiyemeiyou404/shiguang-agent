export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: unknown): Promise<unknown>;
}

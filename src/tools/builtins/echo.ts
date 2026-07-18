import type { Tool, ToolExecutionContext } from "../types.js";

export const echoTool: Tool = {
  descriptor: {
    name: "echo",
    description: "Echoes back the input text",
    inputSchema: { type: "string", description: "The text to echo back" },
    risk: "read",
    requiresApproval: false,
    capability: "utility.echo",
  },
  async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
    return { echoed: String(input ?? "") };
  },
};

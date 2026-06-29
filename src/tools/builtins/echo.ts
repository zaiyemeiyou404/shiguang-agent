import type { Tool } from "../types.js";

export const echoTool: Tool = {
  descriptor: {
    name: "echo",
    description: "Echoes back the input text",
    inputSchema: { type: "string", description: "The text to echo back" },
  },
  async execute(input: unknown): Promise<unknown> {
    return { echoed: String(input ?? "") };
  },
};

import type { Tool, ToolDescriptor } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((t) => t.descriptor);
  }

  async invoke(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(input);
  }
}

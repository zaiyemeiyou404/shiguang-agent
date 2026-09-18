import type { Tool, ToolDescriptor, ToolExecutionContext } from "./types.js";
import { withToolContract } from "./contract.js";
import { ToolHealthTracker, type ToolHealthSnapshot } from "./health.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private readonly health = new ToolHealthTracker();

  register(tool: Tool): void {
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map((t) => withToolContract(t.descriptor));
  }

  async invoke(name: string, input: unknown, context?: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute(input, context);
  }

  recordSuccess(name: string, durationMs: number): ToolHealthSnapshot {
    return this.health.recordSuccess(name, durationMs);
  }

  recordFailure(name: string, durationMs: number, errorKind: string, retryable: boolean): ToolHealthSnapshot {
    return this.health.recordFailure(name, durationMs, errorKind, retryable);
  }

  healthSnapshot(name: string): ToolHealthSnapshot {
    return this.health.snapshot(name);
  }

  allHealth(): ToolHealthSnapshot[] {
    return this.health.all();
  }
}

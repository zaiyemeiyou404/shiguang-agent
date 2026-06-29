import type { BrainDecision, ActionResult } from "../brain/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventSink } from "./event-sink.js";

export class ActionDispatcher {
  constructor(
    private toolRegistry: ToolRegistry,
    private eventSink?: EventSink,
  ) {}

  async dispatch(decision: BrainDecision, runId?: string): Promise<ActionResult> {
    const { action } = decision;

    if (this.eventSink && runId) {
      await this.eventSink.record(runId, "thinking", { reasoning: decision.reasoning });
    }

    switch (action.kind) {
      case "respond": {
        if (this.eventSink && runId) {
          await this.eventSink.record(runId, "message", { content: action.content });
        }
        return { action, ok: true, output: action.content ?? "" };
      }
      case "tool_call": {
        if (!action.toolName) {
          return { action, ok: false, output: null, error: "No tool name provided" };
        }
        if (this.eventSink && runId) {
          await this.eventSink.record(runId, "tool_call", {
            tool: action.toolName,
            input: action.toolInput,
          });
        }
        try {
          const output = await this.toolRegistry.invoke(action.toolName, action.toolInput);
          if (this.eventSink && runId) {
            await this.eventSink.record(runId, "tool_result", {
              tool: action.toolName,
              output,
            });
          }
          return { action, ok: true, output };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { action, ok: false, output: null, error: msg };
        }
      }
      case "finish": {
        return { action, ok: true, output: action.content ?? "Done." };
      }
      case "fail": {
        return { action, ok: false, output: null, error: action.reason ?? "Unknown failure" };
      }
    }
  }
}

import type { BrainDecision, ActionResult, ToolErrorKind } from "../brain/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventSink } from "./event-sink.js";

function summarize(value: unknown, maxLength = 500): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw ?? String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function errorType(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function classifyToolError(err: unknown, message: string): { kind: ToolErrorKind; retryable: boolean } {
  const type = errorType(err).toLowerCase();
  const text = `${type} ${message}`.toLowerCase();
  let kind: ToolErrorKind = "unknown";

  if (/\b(aborterror|timeout|timed out|etimedout|gateway timeout)\b/.test(text)) {
    kind = "timeout";
  } else if (/\b(rate limit|rate_limited|too many requests|429|quota exceeded)\b/.test(text)) {
    kind = "rate_limited";
  } else if (/\b(tool not found|unknown tool|no such tool)\b/.test(text)) {
    kind = "tool_missing";
  } else if (/\b(unauthorized|unauthenticated|auth required|login required|api key|token required|401)\b/.test(text)) {
    kind = "auth_required";
  } else if (/\b(permission denied|forbidden|access denied|eacces|eperm|403)\b/.test(text)) {
    kind = "permission_denied";
  } else if (/\b(invalid input|input must|validation|schema|bad request|malformed|invalid argument|400)\b/.test(text)) {
    kind = "invalid_input";
  } else if (/\b(not found|no such file|enoent|404)\b/.test(text)) {
    kind = "not_found";
  } else if (/\b(conflict|already exists|eexist|409)\b/.test(text)) {
    kind = "conflict";
  } else if (/\b(unavailable|service unavailable|network|econnrefused|econnreset|enotfound|502|503)\b/.test(text)) {
    kind = "unavailable";
  }

  return {
    kind,
    retryable: kind === "timeout" || kind === "unavailable" || kind === "rate_limited",
  };
}

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
        const output = action.content ?? "";
        return {
          action,
          ok: true,
          output,
          metadata: {
            category: "assistant_response",
            summary: summarize(output),
            retryable: false,
          },
        };
      }
      case "tool_call": {
        if (!action.toolName) {
          return {
            action,
            ok: false,
            output: null,
            error: "No tool name provided",
            metadata: {
              category: "runtime_error",
              summary: "No tool name provided",
              retryable: false,
            },
          };
        }
        if (this.eventSink && runId) {
          await this.eventSink.record(runId, "tool_call", {
            tool: action.toolName,
            input: action.toolInput,
          });
        }
        const tool = this.toolRegistry.get(action.toolName);
        if (!tool) {
          return {
            action,
            ok: false,
            output: null,
            error: `Tool not found: ${action.toolName}`,
            metadata: {
              category: "tool_error",
              summary: `Tool not found: ${action.toolName}`,
              retryable: false,
              toolName: action.toolName,
              errorType: "Error",
              errorKind: "tool_missing",
            },
          };
        }
        try {
          const output = await tool.execute(action.toolInput);
          if (this.eventSink && runId) {
            await this.eventSink.record(runId, "tool_result", {
              tool: action.toolName,
              output,
            });
          }
          return {
            action,
            ok: true,
            output,
            metadata: {
              category: "tool_observation",
              summary: summarize(output),
              retryable: false,
              toolName: action.toolName,
              ...(tool.descriptor.effects?.workspaceMutation
                ? { workspaceMutation: true }
                : {}),
              ...(tool.descriptor.effects?.validationMode
                ? { validationMode: tool.descriptor.effects.validationMode }
                : {}),
            },
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const classification = classifyToolError(err, msg);
          return {
            action,
            ok: false,
            output: null,
            error: msg,
            metadata: {
              category: "tool_error",
              summary: summarize(msg, 300),
              retryable: classification.retryable,
              toolName: action.toolName,
              errorType: errorType(err),
              errorKind: classification.kind,
            },
          };
        }
      }
      case "finish": {
        const output = action.content ?? "Done.";
        return {
          action,
          ok: true,
          output,
          metadata: {
            category: "agent_finish",
            summary: summarize(output),
            retryable: false,
          },
        };
      }
      case "fail": {
        const reason = action.reason ?? "Unknown failure";
        return {
          action,
          ok: false,
          output: null,
          error: reason,
          metadata: {
            category: "runtime_error",
            summary: reason,
            retryable: false,
          },
        };
      }
    }
  }
}

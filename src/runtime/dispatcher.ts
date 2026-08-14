import type { BrainDecision, ActionResult, ToolErrorKind } from "../brain/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventSink } from "./event-sink.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { randomUUID } from "node:crypto";

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
    // 这里把“是否值得 loop 再试一次”的判断前置为 metadata，后续 evaluator 直接消费。
    retryable: kind === "timeout" || kind === "unavailable" || kind === "rate_limited",
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function createApprovalId(runId: string | undefined, toolName: string | undefined): string {
  const safeRunId = (runId ?? "run").replace(/[^A-Za-z0-9_-]/g, "_");
  const safeToolName = (toolName ?? "tool").replace(/[^A-Za-z0-9_-]/g, "_");
  return `appr_${safeRunId}_${safeToolName}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

type ToolPipelinePhase =
  | "pre_execute"
  | "approval_required"
  | "approved"
  | "denied"
  | "executing"
  | "completed"
  | "failed";

export class ActionDispatcher {
  constructor(
    private toolRegistry: ToolRegistry,
    private eventSink?: EventSink,
  ) {}

  async dispatch(decision: BrainDecision, runId?: string, context?: ToolExecutionContext): Promise<ActionResult> {
    const { action } = decision;
    throwIfAborted(context?.signal);

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
        // dispatcher 是 action -> side effect 的唯一落点：记录事件、找工具、执行、包装结果。
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
        const toolCallId = randomUUID();
        if (this.eventSink && runId) {
          await this.recordToolPipeline(runId, {
            phase: "pre_execute",
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
          });
          await this.eventSink.record(runId, "tool_call", {
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
          });
        }
        const tool = this.toolRegistry.get(action.toolName);
        if (!tool) {
          await this.recordToolPipeline(runId, {
            phase: "failed",
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
            error: `Tool not found: ${action.toolName}`,
            errorKind: "tool_missing",
          });
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
              toolCallId,
              errorType: "Error",
              errorKind: "tool_missing",
            },
          };
        }
        try {
          await this.recordToolPipeline(runId, {
            phase: "executing",
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
          });
          const output = await tool.execute(action.toolInput, context);
          if (this.eventSink && runId) {
            await this.eventSink.record(runId, "tool_result", {
              tool: action.toolName,
              output,
              toolCallId,
            });
          }
          await this.recordToolPipeline(runId, {
            phase: "completed",
            tool: action.toolName,
            output,
            toolCallId,
          });
          return {
            action,
            ok: true,
            output,
            metadata: {
              category: "tool_observation",
              summary: summarize(output),
              retryable: false,
              toolName: action.toolName,
              toolCallId,
              ...(tool.descriptor.effects?.workspaceMutation
                // workspaceMutation 会驱动 loop/planner 在下一步自动进入 validate。
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
          await this.recordToolPipeline(runId, {
            phase: "failed",
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
            error: msg,
            errorType: errorType(err),
            errorKind: classification.kind,
            retryable: classification.retryable,
          });
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
              toolCallId,
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
      case "needs_approval": {
        // needs_approval 不是普通失败；它要求上层 UI/runtime 暂停并等待人工决策。
        const approvalId = action.approvalId ?? createApprovalId(runId, action.toolName);
        const capability = action.capability ?? action.toolName ?? "unknown";
        const preview = action.toolName
          ? await this.previewApproval(action.toolName, action.toolInput, context)
          : null;
        if (this.eventSink && runId) {
          await this.recordToolPipeline(runId, {
            phase: "approval_required",
            tool: action.toolName,
            input: action.toolInput,
            approvalId,
            capability,
            reason: action.reason,
            ...(preview ? { preview } : {}),
          });
          await this.eventSink.record(runId, "approval_request", {
            approvalId,
            pluginId: "builtin",
            capability,
            request: {
              toolName: action.toolName,
              toolInput: action.toolInput,
              reason: action.reason,
              ...(preview ? { preview } : {}),
            },
          });
        }
        const reason = action.reason ?? `Approval required for tool: ${action.toolName ?? "unknown"}`;
        return {
          action,
          ok: false,
          output: null,
          error: reason,
          metadata: {
            category: "runtime_error",
            summary: reason,
            retryable: false,
            toolName: action.toolName,
            errorType: "ApprovalRequired",
            errorKind: "permission_denied",
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

  private async previewApproval(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<unknown | null> {
    const tool = this.toolRegistry.get(toolName);
    if (!tool?.previewApproval) return null;
    try {
      return await tool.previewApproval(input, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "summary",
        title: `Preview unavailable for ${toolName}`,
        warnings: [message],
      };
    }
  }

  private async recordToolPipeline(runId: string | undefined, payload: {
    phase: ToolPipelinePhase;
    tool?: string;
    input?: unknown;
    output?: unknown;
    toolCallId?: string;
    approvalId?: string;
    capability?: string;
    reason?: string;
    error?: string;
    errorType?: string;
    errorKind?: ToolErrorKind;
    retryable?: boolean;
    preview?: unknown;
  }): Promise<void> {
    if (!this.eventSink || !runId) return;
    await this.eventSink.record(runId, "tool_pipeline", payload);
  }
}

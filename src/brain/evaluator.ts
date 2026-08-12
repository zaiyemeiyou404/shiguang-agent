import type { BrainDecision, ActionResult } from "./types.js";

type ToolErrorResult = ActionResult & {
  metadata: NonNullable<ActionResult["metadata"]> & { category: "tool_error" };
};

export type LoopStopReason =
  | "respond"
  | "finish"
  | "fail"
  | "needs_approval"
  | "step_limit"
  | "non_retryable_tool_error"
  | "repeated_retryable_tool_error";

export type LoopAction =
  | { kind: "continue" }
  | { kind: "stop"; reason: LoopStopReason; summary?: string };

export interface Evaluator {
  evaluate(
    decision: BrainDecision,
    result?: ActionResult,
    history?: ActionResult[],
  ): Promise<LoopAction>;
}

export class BasicEvaluator implements Evaluator {
  async evaluate(
    decision: BrainDecision,
    result?: ActionResult,
    history: ActionResult[] = result ? [result] : [],
  ): Promise<LoopAction> {
    // 对外可见回复也要立刻停；否则同一轮里可能反复生成多条助手消息。
    if (
      decision.action.kind === "respond"
      || decision.action.kind === "finish"
      || decision.action.kind === "fail"
      || decision.action.kind === "needs_approval"
    ) {
      return { kind: "stop", reason: decision.action.kind };
    }

    if (!isToolError(result)) {
      return { kind: "continue" };
    }

    if (result.metadata.retryable !== true) {
      // 不可重试错误交给上层尽快暴露，避免 loop 在错误上下文里空转。
      return {
        kind: "stop",
        reason: "non_retryable_tool_error",
        summary: summarizeToolError(result),
      };
    }

    if (countConsecutiveRetryableToolErrors(history, toolName(result)) >= 3) {
      // 同一工具连续 3 次可重试失败，通常说明外部条件没变，继续重试价值不高。
      return {
        kind: "stop",
        reason: "repeated_retryable_tool_error",
        summary: summarizeToolError(result),
      };
    }

    return { kind: "continue" };
  }
}

function isToolError(result?: ActionResult): result is ToolErrorResult {
  return result?.metadata?.category === "tool_error";
}

function toolName(result: ActionResult): string | undefined {
  return result.metadata?.toolName ?? result.action.toolName;
}

function countConsecutiveRetryableToolErrors(
  history: ActionResult[],
  currentToolName?: string,
): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (
      !isToolError(item)
      || item.metadata.retryable !== true
      || toolName(item) !== currentToolName
    ) {
      break;
    }
    count++;
  }
  return count;
}

function summarizeToolError(result: ActionResult): string {
  const parts = [
    toolName(result) ? `tool=${toolName(result)}` : undefined,
    result.metadata?.errorKind ? `kind=${result.metadata.errorKind}` : undefined,
    result.metadata?.summary ?? result.error,
  ].filter(Boolean);

  return parts.join(": ");
}

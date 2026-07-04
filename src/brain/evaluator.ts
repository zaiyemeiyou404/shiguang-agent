import type { BrainDecision, ActionResult } from "./types.js";

type ToolErrorResult = ActionResult & {
  metadata: NonNullable<ActionResult["metadata"]> & { category: "tool_error" };
};

export type LoopStopReason =
  | "finish"
  | "fail"
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
    if (decision.action.kind === "finish" || decision.action.kind === "fail") {
      return { kind: "stop", reason: decision.action.kind };
    }

    if (!isToolError(result)) {
      return { kind: "continue" };
    }

    if (result.metadata.retryable !== true) {
      return {
        kind: "stop",
        reason: "non_retryable_tool_error",
        summary: summarizeToolError(result),
      };
    }

    if (countConsecutiveRetryableToolErrors(history, toolName(result)) >= 3) {
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

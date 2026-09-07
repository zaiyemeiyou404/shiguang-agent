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
  | "usage_limit"
  | "no_progress"
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
    if (
      decision.action.kind === "respond"
      || decision.action.kind === "finish"
      || decision.action.kind === "fail"
      || decision.action.kind === "needs_approval"
    ) {
      return { kind: "stop", reason: decision.action.kind };
    }

    if (!isToolError(result)) {
      const repeatedNoProgress = detectRepeatedNoProgress(history);
      if (repeatedNoProgress) {
        return {
          kind: "stop",
          reason: "no_progress",
          summary: repeatedNoProgress,
        };
      }
      return { kind: "continue" };
    }

    if (result.metadata.retryable === true && countConsecutiveRetryableToolErrors(history, toolName(result)) >= 3) {
      return {
        kind: "stop",
        reason: "repeated_retryable_tool_error",
        summary: summarizeToolError(result),
      };
    }

    if (result.metadata.retryable !== true && countConsecutiveSameToolErrors(history, result) >= 3) {
      return {
        kind: "stop",
        reason: "non_retryable_tool_error",
        summary: summarizeToolError(result),
      };
    }

    // First-time tool errors flow back into the planner/model so it can repair
    // bad inputs, switch tools, or produce an evidence-based explanation.
    return { kind: "continue" };
  }
}

function detectRepeatedNoProgress(history: ActionResult[]): string | null {
  const recentToolCalls = history
    .filter((item) => item.action.kind === "tool_call")
    .slice(-3);
  if (recentToolCalls.length < 3) return null;

  const latest = recentToolCalls[recentToolCalls.length - 1]!;
  const latestToolName = toolName(latest);
  if (!latestToolName || latest.metadata?.workspaceMutation === true) return null;
  if (latestToolName === "run_validation" || latestToolName === "completion_check") return null;

  const signatures = recentToolCalls.map(noProgressSignature);
  if (!signatures.every((signature) => signature === signatures[0])) return null;

  return [
    `连续 3 次执行了相同的无写入工具动作：${latestToolName}。`,
    "判断为没有新增证据；为避免重复工具循环和继续消耗模型 token，运行已暂停。",
    latest.metadata?.summary ? `最近结果：${latest.metadata.summary}` : null,
    inferNoProgressAdvice(latestToolName),
  ].filter(Boolean).join(" ");
}

function inferNoProgressAdvice(toolName: string): string {
  if (toolName === "web_search") {
    return "建议下一步：如果已有候选链接，改用 web_fetch 抓取正文；如果没有候选链接，再换关键词搜索。";
  }
  if (toolName === "web_fetch") {
    return "建议下一步：改用 web_search 寻找可访问的镜像/转载来源，或让用户补充页面正文。";
  }
  if (toolName === "list_directory") {
    return "建议下一步：改用 read_text_file 读取关键文件，或用 search_workspace 精确定位目标文件。";
  }
  if (toolName === "read_text_file" || toolName === "stat_path") {
    return "建议下一步：改用 search_workspace 按文件名/符号定位真实路径，避免重复读取错误路径。";
  }
  if (toolName === "inspect_project" || toolName === "code_map") {
    return "建议下一步：读取入口文件、配置文件或用户点名文件，再形成结论。";
  }
  return "建议下一步：换一种工具或检查路径继续，而不是重复同一动作。";
}

function noProgressSignature(result: ActionResult): string {
  return [
    toolName(result) ?? "",
    stableJson(result.action.toolInput ?? null),
    result.metadata?.summary ?? "",
    result.ok ? "ok" : "failed",
  ].join("|");
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

function countConsecutiveSameToolErrors(
  history: ActionResult[],
  current: ActionResult,
): number {
  const currentSignature = toolErrorSignature(current);
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!isToolError(item) || toolErrorSignature(item) !== currentSignature) {
      break;
    }
    count++;
  }
  return count;
}

function toolErrorSignature(result: ActionResult): string {
  return [
    toolName(result) ?? "",
    stableJson(result.action.toolInput ?? null),
    result.metadata?.errorKind ?? "",
  ].join("|");
}

function summarizeToolError(result: ActionResult): string {
  const parts = [
    toolName(result) ? `tool=${toolName(result)}` : undefined,
    result.metadata?.errorKind ? `kind=${result.metadata.errorKind}` : undefined,
    result.metadata?.summary ?? result.error,
  ].filter(Boolean);

  return parts.join(": ");
}

function stableJson(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

import type { BrainDecision, ActionResult, ToolErrorKind } from "../brain/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventSink } from "./event-sink.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { inferToolContract } from "../tools/contract.js";
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

interface ToolPipelineDisplay {
  title: string;
  action: string;
  target?: string;
  reason?: string;
  detail: string;
  expected?: string;
  result?: string;
  risk?: string;
  cost?: string;
}

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
            reason: decision.reasoning,
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
          const contract = tool.descriptor.contract ?? inferToolContract(tool.descriptor);
          await this.recordToolPipeline(runId, {
            phase: "executing",
            tool: action.toolName,
            input: action.toolInput,
            toolCallId,
            reason: decision.reasoning,
            contract: summarizeContractForEvent(contract),
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
            input: action.toolInput,
            output,
            toolCallId,
            reason: decision.reasoning,
            contract: summarizeContractForEvent(contract),
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
              ...(contract.effects.workspaceMutation
                // workspaceMutation 会驱动 loop/planner 在下一步自动进入 validate。
                ? { workspaceMutation: true }
                : {}),
              ...(contract.effects.validationMode
                ? { validationMode: contract.effects.validationMode }
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
            reason: decision.reasoning,
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
            ...(action.toolName ? { contract: this.summarizeToolContract(action.toolName) } : {}),
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
    contract?: unknown;
  }): Promise<void> {
    if (!this.eventSink || !runId) return;
    const display = buildToolPipelineDisplay(payload);
    await this.eventSink.record(runId, "tool_pipeline", { ...payload, display });
  }

  private summarizeToolContract(toolName: string): unknown | undefined {
    const tool = this.toolRegistry.get(toolName);
    if (!tool) return undefined;
    return summarizeContractForEvent(tool.descriptor.contract ?? inferToolContract(tool.descriptor));
  }
}

function summarizeContractForEvent(contract: ReturnType<typeof inferToolContract>): Record<string, unknown> {
  return {
    version: contract.version,
    source: contract.source,
    category: contract.category,
    phase: contract.phase,
    risk: contract.risk,
    approval: contract.approval,
    cost: contract.cost,
    recommendedBeforeTools: contract.recommendedBeforeTools,
    recommendedAfterTools: contract.recommendedAfterTools,
    completionSignals: contract.completionSignals,
  };
}

function buildToolPipelineDisplay(payload: {
  phase: ToolPipelinePhase;
  tool?: string;
  input?: unknown;
  output?: unknown;
  reason?: string;
  error?: string;
  retryable?: boolean;
  contract?: unknown;
}): ToolPipelineDisplay {
  const toolLabel = labelTool(payload.tool);
  const target = targetFromToolInput(payload.tool, payload.input) ?? targetFromToolOutput(payload.tool, payload.output);
  const contract = isRecord(payload.contract) ? payload.contract : null;
  const risk = stringFromRecord(contract, "risk");
  const cost = stringFromRecord(contract, "cost");
  const action = actionForTool(payload.tool);
  const reason = cleanReason(payload.reason);
  const expected = expectedOutcomeForTool(payload.tool);
  const result = payload.phase === "completed"
    ? resultSummaryForTool(payload.tool, payload.output)
    : payload.phase === "failed"
      ? failureSummary(payload.error, payload.retryable)
      : undefined;
  const detail = detailForPhase(payload.phase, {
    toolLabel,
    action,
    target,
    reason,
    expected,
    result,
  });

  return {
    title: titleForPhase(payload.phase, toolLabel),
    action,
    ...(target ? { target } : {}),
    ...(reason ? { reason } : {}),
    detail,
    ...(expected ? { expected } : {}),
    ...(result ? { result } : {}),
    ...(risk ? { risk } : {}),
    ...(cost ? { cost } : {}),
  };
}

function titleForPhase(phase: ToolPipelinePhase, toolLabel: string): string {
  if (phase === "pre_execute") return `准备${toolLabel}`;
  if (phase === "executing") return `正在${toolLabel}`;
  if (phase === "completed") return `${toolLabel}完成`;
  if (phase === "failed") return `${toolLabel}失败`;
  if (phase === "approval_required") return `等待审批：${toolLabel}`;
  if (phase === "approved") return `审批通过：${toolLabel}`;
  if (phase === "denied") return `审批拒绝：${toolLabel}`;
  return toolLabel;
}

function detailForPhase(
  phase: ToolPipelinePhase,
  parts: {
    toolLabel: string;
    action: string;
    target?: string;
    reason?: string;
    expected?: string;
    result?: string;
  },
): string {
  const target = parts.target ? `目标：${parts.target}` : null;
  const reason = parts.reason ? `原因：${parts.reason}` : null;
  const expected = parts.expected ? `预期：${parts.expected}` : null;
  const subject = [target, reason, expected].filter(Boolean).join("；");

  if (phase === "pre_execute") return subject || `准备${parts.action}。`;
  if (phase === "executing") return subject || `正在${parts.action}，等待工具返回结果。`;
  if (phase === "completed") return parts.result ?? `${parts.toolLabel}已经完成。`;
  if (phase === "failed") return parts.result ?? `${parts.toolLabel}执行失败，任务循环会把错误带回给模型做恢复判断。`;
  if (phase === "approval_required") return [reason, target, expected].filter(Boolean).join("；") || `这个动作需要你确认后才会执行。`;
  if (phase === "approved") return "已收到审批，正在按原工具输入继续执行。";
  if (phase === "denied") return "你拒绝了这次工具调用，运行会保留现场并等待下一步。";
  return subject || parts.action;
}

function labelTool(toolName: string | undefined): string {
  const labels: Record<string, string> = {
    inspect_project: "检查项目结构",
    list_directory: "浏览目录",
    stat_path: "读取路径信息",
    find_files: "查找文件",
    search_workspace: "搜索工作区",
    read_text_file: "读取文件",
    read_many_files: "批量读取文件",
    write_text_file: "写入文件",
    patch_text_file: "修改文件",
    copy_path: "复制路径",
    move_path: "移动路径",
    delete_path: "删除路径",
    run_terminal_command: "运行命令",
    run_validation: "运行验证",
    collect_diagnostics: "收集诊断",
    code_map: "生成代码地图",
    symbol_search: "搜索符号",
    dependency_graph: "分析依赖",
    github_repo: "读取 GitHub 仓库",
    web_search: "搜索网页",
    web_fetch: "抓取网页",
    web_extract_links: "提取网页链接",
    list_custom_extensions: "查看自定义扩展",
    record_agent_rule: "记录 Agent 规则",
    create_custom_skill: "创建 Skill",
    create_custom_tool: "创建自定义工具",
    run_custom_tool: "运行自定义工具",
    search_memory: "搜索记忆",
    remember_fact: "写入记忆",
    forget_memory: "删除记忆",
    completion_check: "确认任务完成度",
  };
  if (!toolName) return "工具";
  return labels[toolName] ?? toolName.replace(/^mcp_/, "调用 MCP：").replace(/_/g, " ");
}

function actionForTool(toolName: string | undefined): string {
  const actions: Record<string, string> = {
    web_search: "查找候选网页",
    web_fetch: "打开网页并抽取正文",
    web_extract_links: "从网页里提取可继续访问的链接",
    list_directory: "查看目录里有哪些文件",
    inspect_project: "识别项目类型和关键入口",
    find_files: "按名称或模式定位文件",
    read_text_file: "读取目标文件内容",
    read_many_files: "一次读取多个关键文件",
    search_workspace: "在工作区内搜索关键词",
    write_text_file: "写入或覆盖文件",
    patch_text_file: "按补丁修改文件",
    run_terminal_command: "执行终端命令",
    run_validation: "运行测试、类型检查或构建验证",
    completion_check: "判断证据是否足够完成任务",
    record_agent_rule: "把可复用经验保存为规则",
  };
  return toolName ? actions[toolName] ?? labelTool(toolName) : "调用工具";
}

function expectedOutcomeForTool(toolName: string | undefined): string | undefined {
  const expected: Record<string, string> = {
    web_search: "拿到和问题相关的候选来源，而不是直接当作最终答案。",
    web_fetch: "拿到网页标题、正文候选和可读文本，用于后续回答。",
    web_extract_links: "找到正文页、全文页或下一步可抓取的链接。",
    list_directory: "确认路径是否存在，并发现下一步要读的关键文件。",
    inspect_project: "识别项目框架、入口文件和可验证命令。",
    find_files: "定位具体文件，避免凭历史路径乱猜。",
    read_text_file: "获得文件真实内容，再决定是否分析或修改。",
    read_many_files: "减少重复读文件步骤，形成更完整上下文。",
    search_workspace: "找到相关代码位置，再读具体文件确认。",
    write_text_file: "完成文件写入，随后进入验证或总结。",
    patch_text_file: "完成最小改动，随后进入验证或总结。",
    run_terminal_command: "得到命令输出和退出码，供任务循环继续判断。",
    run_validation: "确认改动是否可运行，失败时把错误回灌给模型修复。",
    completion_check: "防止工具循环，确认是否应该结束并反馈。",
    record_agent_rule: "保存可复用做法，避免以后重复犯同类错误。",
  };
  return toolName ? expected[toolName] : undefined;
}

function targetFromToolInput(toolName: string | undefined, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const path = stringFromRecord(input, "path")
    ?? stringFromRecord(input, "targetPath")
    ?? stringFromRecord(input, "cwd")
    ?? stringFromRecord(input, "root");
  const url = stringFromRecord(input, "url");
  const query = stringFromRecord(input, "query");
  const command = stringFromRecord(input, "command");
  const mode = stringFromRecord(input, "mode");
  if (toolName === "web_fetch" && url) return url;
  if (toolName === "web_search" && query) return `查询 "${query}"`;
  if (toolName === "run_terminal_command" && command) return command;
  if (toolName === "run_validation" && mode) return `验证模式 ${mode}`;
  return path ?? url ?? query ?? command ?? mode ?? undefined;
}

function targetFromToolOutput(toolName: string | undefined, output: unknown): string | undefined {
  if (!isRecord(output)) return undefined;
  if (toolName === "web_fetch") return stringFromRecord(output, "url") ?? undefined;
  if (toolName === "web_search") {
    const query = stringFromRecord(output, "query");
    return query ? `查询 "${query}"` : undefined;
  }
  return stringFromRecord(output, "path")
    ?? stringFromRecord(output, "cwd")
    ?? stringFromRecord(output, "root")
    ?? stringFromRecord(output, "command")
    ?? undefined;
}

function resultSummaryForTool(toolName: string | undefined, output: unknown): string | undefined {
  if (!isRecord(output)) return summarize(output, 220);
  if (toolName === "web_search") {
    const results = Array.isArray(output.results) ? output.results : [];
    const query = stringFromRecord(output, "query");
    const first = results.length > 0 && isRecord(results[0]) ? stringFromRecord(results[0], "title") : null;
    return `搜索${query ? ` "${query}"` : ""}，返回 ${results.length} 条结果${first ? `，首条是「${first}」` : ""}。`;
  }
  if (toolName === "web_fetch") {
    const title = stringFromRecord(output, "title");
    const status = numberFromRecord(output, "status");
    const extraction = stringFromRecord(output, "extraction");
    const text = stringFromRecord(output, "text");
    const articleCandidates = Array.isArray(output.articleCandidates) ? output.articleCandidates.length : 0;
    return `网页抓取完成${status !== undefined ? `，状态 ${status}` : ""}${title ? `，标题「${title}」` : ""}${extraction ? `，正文策略 ${extraction}` : ""}${text ? `，可读文本约 ${text.length} 字` : ""}${articleCandidates ? `，正文候选 ${articleCandidates} 个` : ""}。`;
  }
  if (toolName === "list_directory") {
    const entries = Array.isArray(output.entries) ? output.entries : [];
    return `目录可访问，看到 ${entries.length} 个条目。`;
  }
  if (toolName === "read_text_file") {
    const path = stringFromRecord(output, "path");
    const content = stringFromRecord(output, "content");
    const bytes = numberFromRecord(output, "bytes");
    return `已读取${path ? ` ${path}` : "文件"}${bytes !== undefined ? `，${formatBytes(bytes)}` : ""}${content ? `，文本约 ${content.length} 字` : ""}。`;
  }
  if (toolName === "read_many_files") {
    const files = Array.isArray(output.files) ? output.files : [];
    const failed = numberFromRecord(output, "failed");
    return `批量读取 ${files.length} 个文件${failed !== undefined && failed > 0 ? `，${failed} 个失败` : ""}。`;
  }
  if (toolName === "run_terminal_command") {
    const ok = output.ok === true;
    const command = stringFromRecord(output, "command");
    const exitCode = numberFromRecord(output, "exitCode");
    return `${ok ? "命令完成" : "命令失败"}${command ? `：${command}` : ""}${exitCode !== undefined ? `，退出码 ${exitCode}` : ""}。`;
  }
  if (toolName === "run_validation") {
    const ok = output.ok === true;
    const summaryText = stringFromRecord(output, "summary");
    return summaryText ?? (ok ? "验证通过。" : "验证失败，错误会交回任务循环恢复。");
  }
  if (toolName === "completion_check") {
    return stringFromRecord(output, "summary") ?? "完成度检查已返回。";
  }
  return summarize(output, 220);
}

function failureSummary(error: string | undefined, retryable: boolean | undefined): string {
  const suffix = retryable ? "这是可重试错误，任务循环可以换路径或稍后再试。" : "这是非自动重试错误，需要换输入、换工具或向用户说明。";
  return `${error?.trim() || "工具执行失败。"} ${suffix}`;
}

function cleanReason(reason: string | undefined): string | undefined {
  const text = reason?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromRecord(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

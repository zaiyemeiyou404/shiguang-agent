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
  nextStep?: string;
  debugHint?: string;
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
  const nextStep = nextStepForToolPipeline(payload);
  const debugHint = debugHintForToolPipeline(payload);
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
    ...(nextStep ? { nextStep } : {}),
    ...(debugHint ? { debugHint } : {}),
    ...(risk ? { risk } : {}),
    ...(cost ? { cost } : {}),
  };
}

function titleForPhase(phase: ToolPipelinePhase, toolLabel: string): string {
  if (phase === "pre_execute") return `准备${toolLabel}`;
  if (phase === "executing") return `正在${toolLabel}`;
  if (phase === "completed") return completedTitleForTool(toolLabel);
  if (phase === "failed") return `${toolLabel}失败`;
  if (phase === "approval_required") return `等待审批：${toolLabel}`;
  if (phase === "approved") return `审批通过：${toolLabel}`;
  if (phase === "denied") return `审批拒绝：${toolLabel}`;
  return toolLabel;
}

function completedTitleForTool(toolLabel: string): string {
  const labels: Record<string, string> = {
    "检查项目结构": "检查了项目结构",
    "浏览目录": "浏览了目录",
    "读取路径信息": "读取了路径信息",
    "查找文件": "查找了文件",
    "搜索工作区": "搜索了工作区",
    "读取文件": "读取了文件",
    "批量读取文件": "读取了多个文件",
    "写入文件": "写入了文件",
    "修改文件": "修改了文件",
    "复制路径": "复制了路径",
    "移动路径": "移动了路径",
    "删除路径": "删除了路径",
    "运行命令": "运行了命令",
    "运行验证": "运行了验证",
    "收集诊断": "收集了诊断",
    "生成代码地图": "生成了代码地图",
    "搜索符号": "搜索了符号",
    "分析依赖": "分析了依赖",
    "读取 GitHub 仓库": "读取了 GitHub 仓库",
    "搜索网页": "搜索了网页",
    "抓取网页": "抓取了网页",
    "提取网页链接": "提取了网页链接",
    "查看自定义扩展": "查看了自定义扩展",
    "记录 Agent 规则": "记录了 Agent 规则",
    "创建 Skill": "创建了 Skill",
    "创建自定义工具": "创建了自定义工具",
    "运行自定义工具": "运行了自定义工具",
    "搜索记忆": "搜索了记忆",
    "写入记忆": "写入了记忆",
    "删除记忆": "删除了记忆",
    "确认任务完成度": "确认了任务完成度",
  };
  return labels[toolLabel] ?? `${toolLabel}完成`;
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
    const extraction = isRecord(output.extraction) ? output.extraction : null;
    const extractionStrategy = extraction ? stringFromRecord(extraction, "strategy") : undefined;
    const quality = isRecord(extraction?.quality) ? extraction.quality : null;
    const qualityStatus = quality ? stringFromRecord(quality, "status") : undefined;
    const textChars = quality ? numberFromRecord(quality, "textChars") : undefined;
    const text = stringFromRecord(output, "text");
    const articleCandidates = Array.isArray(output.articleCandidates) ? output.articleCandidates.length : 0;
    return `网页抓取完成${status !== undefined ? `，状态 ${status}` : ""}${title ? `，标题「${title}」` : ""}${extractionStrategy ? `，正文策略 ${extractionStrategy}` : ""}${qualityStatus ? `，质量 ${qualityStatus}` : ""}${textChars !== undefined ? `，正文约 ${textChars} 字` : text ? `，可读文本约 ${text.length} 字` : ""}${articleCandidates ? `，正文候选 ${articleCandidates} 个` : ""}。`;
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

function nextStepForToolPipeline(payload: {
  phase: ToolPipelinePhase;
  tool?: string;
  output?: unknown;
  error?: string;
  retryable?: boolean;
}): string | undefined {
  if (payload.phase === "failed") {
    if (payload.tool === "web_fetch") return "把失败原因回灌给任务循环，改用网页搜索、链接提取或换可访问来源。";
    if (payload.tool === "web_search") return "换搜索 provider、简化关键词，或在有明确 URL 时直接抓取网页。";
    if (payload.tool === "read_text_file" || payload.tool === "list_directory") return "先校正路径或查找文件，再读取真实内容。";
    if (payload.tool === "run_validation") return "读取首个失败位置或收集诊断，再做最小修复。";
    return "换参数、换工具或暂停说明阻塞点，不要重复相同失败调用。";
  }

  if (payload.phase !== "completed") return undefined;
  if (payload.tool === "web_search") return "选择最相关结果继续 web_fetch，搜索片段不能直接当最终正文。";
  if (payload.tool === "web_fetch") {
    const extraction = isRecord(payload.output) && isRecord(payload.output.extraction) ? payload.output.extraction : null;
    const quality = isRecord(extraction?.quality) ? stringFromRecord(extraction.quality, "status") : null;
    if (quality === "strong") return "正文证据可用，下一步应基于该正文回答或总结。";
    return "正文质量不足，下一步优先提取链接或换来源。";
  }
  if (payload.tool === "write_text_file" || payload.tool === "patch_text_file") return "改动完成后应运行验证或明确说明未验证原因。";
  if (payload.tool === "run_validation") return "根据验证结果决定总结、修复或继续收集诊断。";
  return undefined;
}

function debugHintForToolPipeline(payload: {
  phase: ToolPipelinePhase;
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}): string | undefined {
  if (payload.phase === "failed") {
    return `debug: tool=${payload.tool ?? "unknown"} input=${summarize(payload.input, 180)} error=${payload.error ?? "unknown"}`;
  }
  if (payload.phase === "completed" && payload.tool === "web_fetch" && isRecord(payload.output)) {
    const extraction = isRecord(payload.output.extraction) ? payload.output.extraction : null;
    const quality = isRecord(extraction?.quality) ? extraction.quality : null;
    const reasons = Array.isArray(quality?.reasons) ? quality.reasons.filter((item): item is string => typeof item === "string") : [];
    if (reasons.length > 0) return `debug: readability=${stringFromRecord(quality, "status") ?? "unknown"} reasons=${reasons.slice(0, 3).join("；")}`;
  }
  return undefined;
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

function numberFromRecord(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

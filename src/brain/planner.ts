import type { BrainInput, BrainDecision, ActionResult, PlannerPhase, WorkingMemorySnapshot } from "./types.js";
import type { ToolDescriptor, ValidationModeHint } from "../tools/types.js";
import type { LlmPlannerModel, LlmPlannerModelRequest, PlannerContext } from "./model-types.js";
import { renderPrompt, type RenderedPrompt } from "../context/render.js";
import { selectToolsForPlanner } from "./tool-selection.js";

export interface Planner {
  decide(input: BrainInput, context?: PlannerContext): Promise<BrainDecision>;
}

export class LlmPlanner implements Planner {
  constructor(private model: LlmPlannerModel) {}

  async decide(input: BrainInput, context?: PlannerContext): Promise<BrainDecision> {
    const lastResult = input.history.length > 0 ? input.history[input.history.length - 1] ?? null : null;
    // 一旦确认发生了 workspace mutation，优先自动跑验证，再把结果交回模型处理。
    const automaticValidationMode = inferAutomaticValidationMode(lastResult, input.availableTools);
    if (automaticValidationMode) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: automaticValidationMode } },
        reasoning: `Successful workspace mutation detected; running validation mode: ${automaticValidationMode}`,
      };
    }

    const completedWebLookup = inferCompletedWebLookupResponse(input, lastResult);
    if (completedWebLookup) return completedWebLookup;

    const initialWebFetch = input.history.length === 0
      ? inferInitialWebFetchUrl(latestUserMessage(input), input.availableTools)
      : null;
    if (initialWebFetch) {
      return {
        action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: initialWebFetch } },
        reasoning: `User provided an explicit URL; fetching it directly: ${initialWebFetch}`,
      };
    }

    const request = this.buildRequest(input);
    const response = await this.model.generateDecision(request, context);
    const decision = { action: response.action, reasoning: response.reasoning };
    const fallback = await inferDeterministicToolFallback(input, decision, context);
    return fallback ?? decision;
  }

  private buildRequest(input: BrainInput): LlmPlannerModelRequest {
    const prompt: RenderedPrompt = renderPrompt(input.context, input.priorTurns);
    const toolSelection = selectToolsForPlanner(input);

    return {
      systemPrompt: prompt.system || undefined,
      messages: prompt.messages,
      availableTools: toolSelection.selected,
      totalAvailableToolCount: toolSelection.total,
      history: input.history,
      workingMemory: input.workingMemory,
    };
  }
}

async function inferDeterministicToolFallback(
  input: BrainInput,
  modelDecision: BrainDecision,
  context?: PlannerContext,
): Promise<BrainDecision | null> {
  if (modelDecision.action.kind !== "respond" && modelDecision.action.kind !== "fail") {
    return null;
  }

  const fallback = await new RulePlanner().decide(input, context);
  if (fallback.action.kind !== "tool_call" || !fallback.action.toolName) {
    return null;
  }

  const descriptor = input.availableTools.find((tool) => tool.name === fallback.action.toolName);
  if (!descriptor || descriptor.requiresApproval === true) {
    return null;
  }

  return {
    action: fallback.action,
    reasoning: [
      `Model returned ${modelDecision.action.kind}; using deterministic safe-tool fallback.`,
      fallback.reasoning,
    ].filter(Boolean).join(" "),
  };
}

export class RulePlanner implements Planner {
  async decide(input: BrainInput, context?: PlannerContext): Promise<BrainDecision> {
    const prompt: RenderedPrompt = renderPrompt(input.context, input.priorTurns);
    const userItem = input.context.volatile.find(i => i.kind === "user_turn");
    const msg = userItem?.content ?? prompt.messages.find(m => m.role === "user")?.content ?? "";

    if (!msg) {
      return {
        action: { kind: "respond", content: "No user input found." },
        reasoning: "Context did not include a user turn.",
      };
    }

    const echoPrefix = "use echo";

    const lastResult = input.history.length > 0
      ? input.history[input.history.length - 1]
      : null;
    const phase = inferPlannerPhase(input, lastResult ?? null, msg);

    // RulePlanner 是最小可运行兜底：没有模型时，靠 phase + history 做有限状态流转。
    if (input.history.length === 0 && msg.toLowerCase().startsWith(echoPrefix)) {
      const rest = msg.slice(echoPrefix.length).trim();
      return {
        action: { kind: "tool_call", toolName: "echo", toolInput: rest || msg },
        reasoning: `User requested echo tool with: ${rest || msg}`,
      };
    }

    const validationMode = input.history.length === 0 ? inferValidationMode(msg) : null;
    if (validationMode && input.availableTools.some((tool) => tool.name === "run_validation")) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: validationMode } },
        reasoning: `User requested validation mode: ${validationMode}`,
      };
    }

    const automaticValidationMode = inferAutomaticValidationMode(lastResult ?? null, input.availableTools);
    if (automaticValidationMode) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: automaticValidationMode } },
        reasoning: `Successful workspace mutation detected; running validation mode: ${automaticValidationMode}`,
      };
    }

    const phaseDecision = decideByPhase(phase, input, msg, lastResult ?? null);
    if (phaseDecision) return phaseDecision;

    if (lastResult && lastResult.action.kind === "tool_call" && lastResult.ok) {
      return {
        action: {
          kind: "respond",
          content: `工具输出：${JSON.stringify(lastResult.output)}`,
        },
        reasoning: `阶段 ${phase}：汇报成功的非验证工具输出，并且不提前结束。`,
      };
    }

    if (lastResult && lastResult.action.kind === "respond") {
      return {
        action: {
          kind: "finish",
          content: `上一条回复是：「${lastResult.output}」。处理完成。`,
        },
        reasoning: "已经回复过用户，结束当前流程。",
      };
    }

    return {
      action: {
        kind: "respond",
        content: `我收到了你的消息：「${msg}」。请告诉我下一步需要做什么。`,
      },
      reasoning: "当前不需要调用工具，先给出简短回复。",
    };
  }
}

function decideByPhase(
  phase: PlannerPhase,
  input: BrainInput,
  message: string,
  lastResult: ActionResult | null,
): BrainDecision | null {
  switch (phase) {
    case "investigate": {
      // exhausted 表示同一 suspect 已经多轮修复失败，此时优先重新读证据而不是盲改。
      const exhaustedSuspectPaths = inferExhaustedRepairSuspectPaths(input.workingMemory);
      if (exhaustedSuspectPaths.length > 0) {
        const latestReadPath = inferReadPath(lastResult);
        if (latestReadPath && isExhaustedSearchCandidatePath(input.workingMemory, latestReadPath)) {
          const mutationDecision = inferEditMutation(input, lastResult);
          if (mutationDecision) return mutationDecision;

          const nextSearchRead = inferExhaustedRepairSearchRead(input.workingMemory, input.availableTools, input.history, lastResult);
          if (nextSearchRead) {
            return {
              action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: nextSearchRead.path } },
              reasoning: `Phase investigate: no new deterministic edit for searched candidate ${latestReadPath}; reading next ranked search candidate ${nextSearchRead.path}.`,
            };
          }

          return createExhaustedRepairFail(input.workingMemory, "No new concrete deterministic fix was found after reading the ranked search candidates.");
        }

        if (latestReadPath && exhaustedSuspectPaths.includes(latestReadPath)) {
          const nextRepairRead = inferRepairReinvestigationRead(input.workingMemory, input.availableTools, input.history, latestReadPath);
          if (nextRepairRead && input.workingMemory?.repairAttempt?.triedSuspectPaths?.includes(latestReadPath)) {
            return {
              action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: nextRepairRead.path } },
              reasoning: `Phase investigate: exhausted repair already tried ${latestReadPath}; reading alternate suspect path ${nextRepairRead.path}.`,
            };
          }

          const mutationDecision = inferEditMutation(input, lastResult);
          if (mutationDecision) return mutationDecision;

          if (nextRepairRead) {
            return {
              action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: nextRepairRead.path } },
              reasoning: `Phase investigate: no new deterministic edit for ${latestReadPath}; reading alternate suspect path ${nextRepairRead.path}.`,
            };
          }

          const searchDecision = inferExhaustedRepairSearchDecision(input);
          if (searchDecision) return searchDecision;

          return createExhaustedRepairFail(input.workingMemory, "No new concrete deterministic fix was found after re-reading the deterministic suspect files.");
        }

        if (!hasTool(input.availableTools, "read_text_file")) {
          return createExhaustedRepairFail(input.workingMemory, "Repair attempts are exhausted and read_text_file is unavailable for re-investigation.");
        }
      }

      const repairRead = inferRepairReinvestigationRead(input.workingMemory, input.availableTools, input.history);
      if (repairRead) {
        return {
          action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: repairRead.path } },
          reasoning: `Phase investigate: repair attempts exhausted; reading deterministic suspect path ${repairRead.path} before editing.`,
        };
      }

      const exhaustedSearchRead = inferExhaustedRepairSearchRead(input.workingMemory, input.availableTools, input.history, lastResult);
      if (exhaustedSearchRead) {
        return {
          action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: exhaustedSearchRead.path } },
          reasoning: `Phase investigate: reading top ranked exhausted-repair search candidate ${exhaustedSearchRead.path}.`,
        };
      }

      const exhaustedSearchDecision = inferExhaustedRepairSearchDecision(input);
      if (exhaustedSearchDecision) return exhaustedSearchDecision;

      const initialWebSearch = input.history.length === 0
        ? inferInitialWebSearchQuery(message, input.availableTools)
        : null;
      const initialWebFetch = input.history.length === 0
        ? inferInitialWebFetchUrl(message, input.availableTools)
        : null;
      if (initialWebFetch) {
        return {
          action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: initialWebFetch } },
          reasoning: `Phase investigate: user provided an explicit URL; fetching it directly: ${initialWebFetch}`,
        };
      }
      if (initialWebSearch) {
        return {
          action: { kind: "tool_call", toolName: "web_search", toolInput: { query: initialWebSearch, limit: 5 } },
          reasoning: `Phase investigate: user asked for online search; starting with web_search: ${initialWebSearch}`,
        };
      }

      const projectInspection = input.history.length === 0
        ? inferInitialProjectInspection(message, input.availableTools)
        : null;
      if (projectInspection) {
        return {
          action: { kind: "tool_call", toolName: "inspect_project", toolInput: {} },
          reasoning: "Phase investigate: starting unfamiliar project work with inspect_project.",
        };
      }

      const followupRead = inferFollowupRead(lastResult, input.availableTools, input.history);
      if (followupRead) {
        return {
          action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: followupRead.path } },
          reasoning: `Phase investigate: reading the next high-signal file: ${followupRead.path}`,
        };
      }

      const searchFallback = inferEmptySearchFallback(lastResult, input.availableTools);
      if (searchFallback) {
        return {
          action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: searchFallback.path } },
          reasoning: `Phase investigate: empty search result; listing ${searchFallback.path} to discover likely files before responding.`,
        };
      }

      const initialSearchQuery = input.history.length === 0
        ? inferInitialSearchQuery(message, input.availableTools)
        : null;
      if (initialSearchQuery) {
        return {
          action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: initialSearchQuery } },
          reasoning: `Phase investigate: starting with workspace search: ${initialSearchQuery}`,
        };
      }

      const observationResponse = summarizeObservation(lastResult, message);
      if (observationResponse) {
        return {
          action: { kind: "respond", content: observationResponse },
          reasoning: "Phase investigate: summarizing available read-only evidence.",
        };
      }

      return null;
    }

    case "edit": {
      // edit 阶段只做“有明确证据支撑”的最小改动；推不出安全修改时宁可停在 respond。
      const mutationDecision = inferEditMutation(input, lastResult);
      if (mutationDecision) return mutationDecision;
      return {
        action: {
          kind: "respond",
          content: "I found edit intent, but this minimal rule planner needs a suspect file and recent file context before it can choose a safe mutation tool.",
        },
        reasoning: "Phase edit: no safe built-in mutation action could be derived from the current context.",
      };
    }

    case "validate": {
      // validate 阶段只负责把最近一次修改送去校验，不做额外推理。
      const validationMode = inferAutomaticValidationMode(lastResult, input.availableTools);
      if (validationMode) {
        return {
          action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: validationMode } },
          reasoning: `Phase validate: running validation mode: ${validationMode}`,
        };
      }
      return null;
    }

    case "summarize": {
      const webLookupResponse = inferCompletedWebLookupResponse(input, lastResult);
      if (webLookupResponse) return webLookupResponse;

      const projectFollowupRead = inferProjectAnalysisFollowupRead(input, message);
      if (projectFollowupRead) {
        return {
          action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: projectFollowupRead.path } },
          reasoning: `Phase summarize: project analysis still lacks key file evidence; reading ${projectFollowupRead.path}.`,
        };
      }

      const projectCodeMap = inferProjectAnalysisCodeMap(input, message);
      if (projectCodeMap) {
        return projectCodeMap;
      }

      const projectSummary = summarizeProjectAnalysis(input.history, message);
      if (projectSummary) {
        return {
          action: { kind: "respond", content: projectSummary },
          reasoning: "Phase summarize: reporting project analysis from collected evidence.",
        };
      }

      // summarize 阶段把最近的只读观察转成用户可消费的短回复。
      const observationResponse = summarizeObservation(lastResult, message);
      if (observationResponse) {
        return {
          action: { kind: "respond", content: observationResponse },
          reasoning: "Phase summarize: reporting the latest observation.",
        };
      }
      return null;
    }
  }
}

function inferCompletedWebLookupResponse(input: BrainInput, lastResult: ActionResult | null): BrainDecision | null {
  if (!lastResult || !lastResult.ok || lastResult.action.kind !== "tool_call") return null;
  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;
  if (toolName !== "web_search" && toolName !== "web_fetch") return null;
  const message = latestUserMessage(input);
  if (!isWebLookupIntent(message) && !isContinuationInstruction(message)) return null;

  const content = summarizeObservation(lastResult, message);
  if (!content) return null;
  return {
    action: { kind: "respond", content },
    reasoning: `Web lookup completed with ${toolName}; returning online results instead of continuing local workspace inspection.`,
  };
}

function inferPlannerPhase(input: BrainInput, lastResult: ActionResult | null, message: string): PlannerPhase {
  if (input.workingMemory?.phase) return input.workingMemory.phase;

  if (!lastResult) {
    return needsInvestigation(message) ? "investigate" : "summarize";
  }

  if (lastResult.action.kind === "respond" || lastResult.action.kind === "finish" || lastResult.action.kind === "fail") {
    return "summarize";
  }

  if (lastResult.action.kind !== "tool_call") {
    return "summarize";
  }

  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;
  if (toolName === "run_validation") return "summarize";
  if (lastResult.metadata?.workspaceMutation === true) return "validate";
  if (toolName === "search_workspace") return "investigate";
  if (lastResult.ok && lastResult.metadata?.category === "tool_observation") return "summarize";

  return needsInvestigation(message) ? "investigate" : "summarize";
}

function inferRepairReinvestigationRead(
  workingMemory: WorkingMemorySnapshot | undefined,
  availableTools: ToolDescriptor[],
  history: ActionResult[],
  excludePath?: string,
): { path: string } | null {
  const suspectPaths = inferExhaustedRepairSuspectPaths(workingMemory);
  if (suspectPaths.length === 0) return null;
  if (!hasTool(availableTools, "read_text_file")) return null;

  const unreadPath = suspectPaths.find((path) => path !== excludePath && !findRecentRead(history, path));
  if (unreadPath) return { path: unreadPath };

  const untriedPath = suspectPaths.find((path) => path !== excludePath
    && !findRecentRead(history, path)
    && !workingMemory?.repairAttempt?.triedSuspectPaths?.includes(path));
  if (untriedPath) return { path: untriedPath };

  return null;
}

function inferExhaustedRepairSearchDecision(input: BrainInput): BrainDecision | null {
  const workingMemory = input.workingMemory;
  if (!isRepairExhausted(workingMemory)) return null;
  if (!hasTool(input.availableTools, "search_workspace")) return null;
  if (!hasTool(input.availableTools, "read_text_file")) return null;
  if (inferRepairReinvestigationRead(workingMemory, input.availableTools, input.history)) return null;

  const query = inferExhaustedRepairSearchQuery(workingMemory);
  if (!query) return null;

  const lastSearch = inferSearchAction(input.history[input.history.length - 1] ?? null);
  if (lastSearch?.query === query) {
    return null;
  }

  if (workingMemory?.repairAttempt?.exhaustedSearchQuery === query) {
    const unreadCandidate = inferExhaustedRepairSearchRead(workingMemory, input.availableTools, input.history, null);
    if (unreadCandidate) return null;
    return null;
  }

  return {
    action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query } },
    reasoning: `Phase investigate: deterministic suspect paths are exhausted; searching workspace for related repair candidates with query: ${query}`,
  };
}

function inferExhaustedRepairSearchRead(
  workingMemory: WorkingMemorySnapshot | undefined,
  availableTools: ToolDescriptor[],
  history: ActionResult[],
  lastResult: ActionResult | null,
): { path: string } | null {
  if (!isRepairExhausted(workingMemory)) return null;
  if (!hasTool(availableTools, "read_text_file")) return null;

  const ranked = rankExhaustedSearchCandidatePaths(workingMemory, history, lastResult);
  const selected = ranked.find((path) => !findRecentRead(history, path)
    && !workingMemory?.repairAttempt?.triedSuspectPaths?.includes(path)
    && !workingMemory?.repairAttempt?.exhaustedReadCandidatePaths?.includes(path));
  return selected ? { path: selected } : null;
}

function inferExhaustedRepairSuspectPaths(workingMemory: WorkingMemorySnapshot | undefined): string[] {
  return workingMemory?.repairAttempt?.exhausted === true
    ? inferRepairSuspectPaths(workingMemory.validationFailure, workingMemory.repairAttempt.suspectFile)
    : [];
}

function inferValidationMode(message: string): "typecheck" | "test" | "build" | "all" | null {
  const text = message.toLowerCase();

  if (text.includes("typecheck") || /类型检查|类型|tsc/.test(message)) return "typecheck";
  if (text.includes("run tests") || /\btests?\b/.test(text) || /测试|单测/.test(message)) return "test";
  if (/\bbuild\b/.test(text) || /构建|编译|打包/.test(message)) return "build";
  if (text.includes("validate") || text.includes("validation") || /验证|检查|能不能跑|能否运行|跑一下|能跑吗/.test(message)) return "all";

  return null;
}

function inferInitialProjectInspection(message: string, availableTools: ToolDescriptor[]): boolean {
  if (!hasTool(availableTools, "inspect_project")) return false;
  const text = message.toLowerCase();
  return /\b(project|repo|repository|workspace|codebase)\b/.test(text)
    || /项目|仓库|工程|代码库/.test(message);
}

function inferAutomaticValidationMode(
  lastResult: ActionResult | null,
  availableTools: ToolDescriptor[],
): ValidationModeHint | null {
  if (!lastResult || !lastResult.ok) return null;
  if (lastResult.action.kind !== "tool_call") return null;
  if (!availableTools.some((tool) => tool.name === "run_validation")) return null;
  if (lastResult.metadata?.category !== "tool_observation") return null;
  if (lastResult.metadata.toolName === "run_validation") return null;
  if (lastResult.metadata.workspaceMutation !== true) return null;

  return lastResult.metadata.validationMode ?? "all";
}

function inferInitialSearchQuery(message: string, availableTools: ToolDescriptor[]): string | null {
  if (!availableTools.some((tool) => tool.name === "search_workspace")) return null;

  const text = message.trim();
  if (!needsInvestigation(text)) {
    return null;
  }

  const explicitPathMatch = text.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/);
  if (explicitPathMatch?.[1]) {
    return explicitPathMatch[1];
  }

  const secretAnswerMatch = text.match(/\b(secret\s+answer)\b/i)?.[1];
  if (secretAnswerMatch) {
    return secretAnswerMatch.toLowerCase();
  }

  const normalized = normalizeSearchQuery(text)
    .split(/\s+/)
    .filter((token) => token.length >= 1);

  if (normalized.length === 0) return null;
  return normalized.slice(0, 4).join(" ");
}

function inferInitialWebSearchQuery(message: string, availableTools: ToolDescriptor[]): string | null {
  if (!hasTool(availableTools, "web_search")) return null;
  if (extractFirstHttpUrl(message)) return null;
  if (!isWebLookupIntent(message)) return null;
  if (isLocalWorkspaceLookupIntent(message)) return null;

  const normalized = message
    .replace(/你能|能不能|可以|帮我|请|一下|吗|？|\?/g, " ")
    .replace(/联网|上网|网上|网页|网络|搜索|搜|查询|查找|查|检索/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || message.trim();
}

function inferInitialWebFetchUrl(message: string, availableTools: ToolDescriptor[]): string | null {
  if (!hasTool(availableTools, "web_fetch")) return null;
  return extractFirstHttpUrl(message);
}

function extractFirstHttpUrl(message: string): string | null {
  const raw = message.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (!raw) return null;
  const cjkIndex = raw.search(/[\u4e00-\u9fff]/);
  const withoutTrailingText = cjkIndex > 0 ? raw.slice(0, cjkIndex) : raw;
  const trimmed = withoutTrailingText.replace(/[),.;，。！？、]+$/g, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function needsInvestigation(message: string): boolean {
  return /\b(fix|debug|investigate|inspect|update|change|modify|edit|repair|error|failure|bug|find|search|read|show|list|open|locate|lookup|trace|explore)\b/i.test(message)
    || /修|改|看一下|检查|排查|调试|找|搜索|读取|打开|列出|项目|仓库|工程|报错|错误|失败|不能跑|能不能跑|测试|验证/.test(message);
}

function latestUserMessage(input: BrainInput): string {
  return [...input.context.volatile].reverse().find((item) => item.kind === "user_turn")?.content
    ?? input.context.volatile.find((item) => item.kind === "user_turn")?.content
    ?? "";
}

function isWebLookupIntent(message: string): boolean {
  const text = message.toLowerCase();
  const hasWebWord = /联网|上网|网上|网页|网络搜索|网页搜索|搜索网页|搜索网络|官网|新闻|资料|文档|github|release|url|http|https|web|fetch|browser|online|latest|current/.test(text);
  const hasFreshWord = /最新|最近|今天|当前|现在|价格|版本|发布|release|latest|current|today|recent/.test(text);
  const hasSearchWord = /搜|搜索|查|查询|查找|检索|look up|search|find/.test(text);
  return hasWebWord || (hasSearchWord && hasFreshWord) || (hasSearchWord && !isLocalWorkspaceLookupIntent(message));
}

function isLocalWorkspaceLookupIntent(message: string): boolean {
  return /工作区|本地|项目|工程|代码|文件|目录|路径|仓库|workspace|repo|repository|codebase|file|folder|directory|path/.test(message.toLowerCase());
}

function isContinuationInstruction(message: string): boolean {
  return /继续|续跑|暂停|checkpoint|上次|上一轮|resume|continue/i.test(message);
}

function inferEmptySearchFallback(
  lastResult: ActionResult | null,
  availableTools: ToolDescriptor[],
): { path: string } | null {
  if (!hasTool(availableTools, "list_directory")) return null;
  if (!lastResult || !lastResult.ok) return null;
  if (lastResult.action.kind !== "tool_call" || lastResult.action.toolName !== "search_workspace") return null;
  const output = lastResult.output as { results?: Array<unknown> } | null;
  if (!Array.isArray(output?.results) || output.results.length > 0) return null;
  return { path: "." };
}

function inferFollowupRead(
  lastResult: ActionResult | null,
  availableTools: ToolDescriptor[],
  history: ActionResult[] = lastResult ? [lastResult] : [],
): { path: string } | null {
  if (!lastResult || !lastResult.ok) return null;
  if (lastResult.action.kind !== "tool_call") return null;
  if (!availableTools.some((tool) => tool.name === "read_text_file")) return null;

  const keyPath = inferNextKeyReadPath(history);
  return keyPath ? { path: keyPath } : null;
}

const MAX_PROJECT_ANALYSIS_KEY_READS = 3;

function inferProjectAnalysisFollowupRead(
  input: BrainInput,
  message: string,
): { path: string } | null {
  if (!hasTool(input.availableTools, "read_text_file")) return null;
  if (isSpecificLookupIntent(message)) return null;
  if (!isProjectAnalysisIntent(message) && !hasProjectShapeEvidence(input.history)) return null;
  if (countReadTextFileCalls(input.history) >= MAX_PROJECT_ANALYSIS_KEY_READS) return null;

  const keyPath = inferNextKeyReadPath(input.history);
  return keyPath ? { path: keyPath } : null;
}

function inferProjectAnalysisCodeMap(input: BrainInput, message: string): BrainDecision | null {
  if (!hasTool(input.availableTools, "code_map")) return null;
  if (isSpecificLookupIntent(message)) return null;
  if (!isProjectAnalysisIntent(message) && !hasProjectShapeEvidence(input.history)) return null;
  if (hasRecentTool(input.history, "code_map")) return null;
  if (!hasProjectShapeEvidence(input.history) && countReadTextFileCalls(input.history) === 0) return null;

  return {
    action: { kind: "tool_call", toolName: "code_map", toolInput: { maxFiles: 1200, includeTests: false } },
    reasoning: "Project analysis needs entrypoint and structure evidence; running code_map before final summary.",
  };
}

function inferNextKeyReadPath(history: ActionResult[]): string | null {
  const readPaths = new Set(
    history
      .map((result) => result.action.kind === "tool_call" && result.action.toolName === "read_text_file"
        ? inferReadPath(result)
        : null)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );
  return collectKeyReadCandidates(history).find((path) => !readPaths.has(path)) ?? null;
}

function collectKeyReadCandidates(history: ActionResult[]): string[] {
  const paths: string[] = [];

  for (const result of history) {
    if (!result.ok || result.action.kind !== "tool_call") continue;
    if (result.action.toolName === "search_workspace") {
      const output = result.output as { results?: Array<{ file?: unknown }> } | null;
      if (Array.isArray(output?.results)) {
        for (const item of output.results) {
          if (typeof item.file === "string") paths.push(toPlannerPortablePath(item.file));
        }
      }
    }
    if (result.action.toolName === "list_directory") {
      const output = result.output as { entries?: Array<{ path?: unknown; kind?: unknown }> } | null;
      if (Array.isArray(output?.entries)) {
        for (const item of output.entries) {
          if (typeof item.path === "string" && item.kind === "file") paths.push(toPlannerPortablePath(item.path));
        }
      }
    }
    if (result.action.toolName === "inspect_project") {
      const output = result.output as { topLevelEntries?: Array<{ path?: unknown; kind?: unknown }> } | null;
      if (Array.isArray(output?.topLevelEntries)) {
        for (const item of output.topLevelEntries) {
          if (typeof item.path === "string" && item.kind === "file") paths.push(toPlannerPortablePath(item.path));
        }
      }
    }
    if (result.action.toolName === "code_map") {
      const output = result.output as { entrypoints?: Array<string | { path?: unknown; file?: unknown }> } | null;
      if (Array.isArray(output?.entrypoints)) {
        for (const item of output.entrypoints) {
          if (typeof item === "string") paths.push(toPlannerPortablePath(item));
          else if (typeof item.path === "string") paths.push(toPlannerPortablePath(item.path));
          else if (typeof item.file === "string") paths.push(toPlannerPortablePath(item.file));
        }
      }
    }
  }

  return uniqueCompact(paths)
    .map((path) => ({ path, score: scoreKeyReadPath(path) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((item) => item.path);
}

function scoreKeyReadPath(path: string): number {
  const normalized = toPlannerPortablePath(path).toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (normalized.includes("/node_modules/") || normalized.includes("/.git/")) return 0;
  if (name === "pubspec.yaml") return 120;
  if (name === "package.json") return 115;
  if (name === "pyproject.toml" || name === "requirements.txt") return 110;
  if (name === "cargo.toml" || name === "go.mod") return 108;
  if (name === "pom.xml" || name === "build.gradle" || name === "settings.gradle") return 104;
  if (/^readme(?:\.[a-z0-9]+)?$/.test(name)) return 96;
  if (normalized === "lib/main.dart") return 94;
  if (normalized === "src/main.ts" || normalized === "src/main.tsx") return 92;
  if (normalized === "src/index.ts" || normalized === "src/index.tsx") return 90;
  if (name === "main.py" || name === "app.py") return 88;
  if (normalized.startsWith("lib/") && normalized.endsWith(".dart")) return 70;
  if (normalized.startsWith("src/") && /\.(ts|tsx|js|jsx|py)$/.test(normalized)) return 65;
  if (/\.(md|yaml|yml|toml|json)$/.test(normalized)) return 45;
  return 0;
}

function isProjectAnalysisIntent(message: string): boolean {
  return /\b(project|repo|repository|workspace|codebase|architecture|structure|analy[sz]e)\b/i.test(message)
    || /项目|仓库|工程|代码库|架构|结构|分析|看一下/.test(message);
}

function isSpecificLookupIntent(message: string): boolean {
  return /\b(answer|secret|value|token|key|file and value|find the)\b/i.test(message)
    || /答案|密钥|令牌|具体值|文件和值|找出|查找/.test(message);
}

function hasProjectShapeEvidence(history: ActionResult[]): boolean {
  return history.some((result) => {
    if (!result.ok || result.action.kind !== "tool_call") return false;
    if (result.action.toolName === "inspect_project" || result.action.toolName === "code_map") return true;
    const paths = collectKeyReadCandidates([result]);
    return paths.some((path) => scoreKeyReadPath(path) >= 100);
  });
}

function hasRecentTool(history: ActionResult[], toolName: string): boolean {
  return history.slice(-8).some((result) => result.action.kind === "tool_call" && result.action.toolName === toolName);
}

function countReadTextFileCalls(history: ActionResult[]): number {
  return history.filter((result) => result.ok && result.action.kind === "tool_call" && result.action.toolName === "read_text_file").length;
}

function summarizeProjectAnalysis(history: ActionResult[], message: string): string | null {
  if (isSpecificLookupIntent(message)) return null;
  if (!isProjectAnalysisIntent(message) && !hasProjectShapeEvidence(history)) return null;
  const readPaths = uniqueCompact(
    history
      .map((result) => result.action.kind === "tool_call" && result.action.toolName === "read_text_file" ? inferReadPath(result) : null)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );
  const hasStrongProjectEvidence = hasProjectShapeEvidence(history)
    || readPaths.some((path) => scoreKeyReadPath(path) >= 100)
    || Boolean(findLatestToolOutput(history, "code_map"))
    || Boolean(findLatestToolOutput(history, "inspect_project"));
  if (!hasStrongProjectEvidence) return null;
  const codeMap = findLatestToolOutput(history, "code_map") as {
    frameworks?: unknown;
    entrypoints?: unknown;
    directories?: unknown;
    fileStats?: { filesScanned?: unknown; byExtension?: unknown; truncated?: unknown };
  } | null;
  const inspect = findLatestToolOutput(history, "inspect_project") as {
    detected?: unknown;
    fileStats?: { filesScanned?: unknown; byExtension?: unknown; truncated?: unknown };
    package?: { name?: unknown; version?: unknown } | null;
  } | null;

  if (readPaths.length === 0 && !codeMap && !inspect) return null;

  const detected = Array.isArray(codeMap?.frameworks) && codeMap.frameworks.length > 0
    ? codeMap.frameworks.join(", ")
    : Array.isArray(inspect?.detected) && inspect.detected.length > 0
      ? inspect.detected.join(", ")
      : "暂未识别到明确框架";
  const packageName = typeof inspect?.package?.name === "string" ? inspect.package.name : null;
  const fileStats = codeMap?.fileStats ?? inspect?.fileStats;
  const filesScanned = typeof fileStats?.filesScanned === "number" ? `${fileStats.filesScanned} 个文件` : "若干文件";
  const entrypoints = formatEntryPoints(codeMap?.entrypoints);

  return [
    "已完成初步项目分析：",
    packageName ? `项目名：${packageName}` : null,
    `识别结果：${detected}。`,
    `已读取关键文件：${readPaths.length > 0 ? readPaths.join("、") : "暂无单文件读取，仅完成结构扫描"}。`,
    entrypoints ? `疑似入口：${entrypoints}。` : null,
    `结构扫描：覆盖 ${filesScanned}${fileStats?.truncated === true ? "，结果已截断" : ""}。`,
    "如果要继续深入，我建议下一步读取入口文件和核心业务目录，再做依赖/运行风险分析。",
  ].filter(Boolean).join("\n");
}

function findLatestToolOutput(history: ActionResult[], toolName: string): unknown | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const result = history[index];
    if (result?.ok && result.action.kind === "tool_call" && result.action.toolName === toolName) {
      return result.output;
    }
  }
  return null;
}

function formatEntryPoints(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as { path?: unknown; file?: unknown };
        if (typeof record.path === "string") return record.path;
        if (typeof record.file === "string") return record.file;
      }
      return null;
    })
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  return uniqueCompact(paths).slice(0, 5).join("、") || null;
}

function toPlannerPortablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function inferEditMutation(input: BrainInput, lastResult: ActionResult | null): BrainDecision | null {
  const candidatePaths = inferEditCandidatePaths(input.workingMemory, lastResult);
  if (candidatePaths.length === 0) return null;

  if (hasTool(input.availableTools, "patch_text_file")) {
    let sawRepeated = false;
    for (const suspectFile of candidatePaths) {
      const recentRead = findRecentRead(input.history, suspectFile);
      const guidedPatchPlan = inferValidationGuidedPatchPlan(input.workingMemory, recentRead);
      const patchPlan = guidedPatchPlan
        ?? (isRepairExhausted(input.workingMemory) ? null : inferPlaceholderPatchPlan(input.workingMemory, recentRead));
      if (!patchPlan) continue;
      const patchSignature = createPatchSignature(suspectFile, patchPlan.oldString, patchPlan.newString);
      const strategy = patchPlan.reason ?? "conservative placeholder patch";
      if (isRepeatedRepairSignature(input.workingMemory, suspectFile, patchSignature)
        || isRepeatedStrategyPath(input.workingMemory, strategy, suspectFile)) {
        sawRepeated = true;
        continue;
      }
      return {
        action: {
          kind: "tool_call",
          toolName: "patch_text_file",
          toolInput: {
            path: suspectFile,
            oldString: patchPlan.oldString,
            newString: patchPlan.newString,
          },
        },
        reasoning: patchPlan.reason
          ? `Phase edit: choosing patch_text_file for suspect path ${suspectFile}; ${patchPlan.reason}.`
          : `Phase edit: choosing patch_text_file for suspect path ${suspectFile} using a conservative placeholder patch.`,
      };
    }

    if (sawRepeated && !hasUntriedRepairCandidate(input.workingMemory, input.history)) {
      return createExhaustedRepairFail(
        input.workingMemory,
        "Refusing to repeat the same deterministic patch_text_file edit after failed validation.",
      );
    }
    return null;
  }

  if (hasTool(input.availableTools, "write_text_file")) {
    for (const suspectFile of candidatePaths) {
      const recentRead = findRecentRead(input.history, suspectFile);
      if (!recentRead) continue;

      const guidedRewrite = inferValidationGuidedRewrite(input.workingMemory, recentRead);
      if (guidedRewrite) {
        if (guidedRewrite.signatures.some((signature) => isRepeatedRepairSignature(input.workingMemory, suspectFile, signature))) {
          continue;
        }
        if (isRepeatedStrategyPath(input.workingMemory, "write_text_file", suspectFile)) {
          continue;
        }
        return {
          action: {
            kind: "tool_call",
            toolName: "write_text_file",
            toolInput: {
              path: suspectFile,
              content: guidedRewrite.content,
            },
          },
          reasoning: `Phase edit: patch_text_file unavailable; writing validation-guided full-file rewrite for ${suspectFile}.`,
        };
      }

      const writeSignature = createWriteSignature(suspectFile, recentRead.content);
      if (isRepeatedRepairSignature(input.workingMemory, suspectFile, writeSignature)
        || isRepeatedStrategyPath(input.workingMemory, "write_text_file", suspectFile)) {
        continue;
      }

      return {
        action: {
          kind: "tool_call",
          toolName: "write_text_file",
          toolInput: {
            path: suspectFile,
            content: recentRead.content,
          },
        },
        reasoning: `Phase edit: patch_text_file unavailable; conservatively rewriting latest read content for ${suspectFile}.`,
      };
    }

    if (!hasUntriedRepairCandidate(input.workingMemory, input.history)) {
      return createExhaustedRepairFail(
        input.workingMemory,
        "Refusing to repeat the same deterministic write_text_file rewrite after failed validation.",
      );
    }
  }

  return null;
}

function inferValidationGuidedRewrite(
  workingMemory: WorkingMemorySnapshot | undefined,
  recentRead: { path: string; content: string },
): { content: string; signatures: string[] } | null {
  const patchPlan = inferValidationGuidedPatchPlan(workingMemory, recentRead);
  if (!patchPlan || patchPlan.oldString === patchPlan.newString) return null;
  const signatures = [
    createWriteSignature(recentRead.path, ""),
    createPatchSignature(recentRead.path, patchPlan.oldString, patchPlan.newString),
  ];

  const suspectLine = workingMemory?.validationFailure?.suspectFile === recentRead.path
    ? workingMemory?.validationFailure?.suspectLine
    : undefined;
  if (typeof suspectLine === "number" && suspectLine > 0) {
    const lines = recentRead.content.split("\n");
    const index = suspectLine - 1;
    if (lines[index] !== patchPlan.oldString) return null;

    lines[index] = patchPlan.newString;
    const rewritten = lines.join("\n");
    signatures[0] = createWriteSignature(recentRead.path, rewritten);
    return rewritten === recentRead.content
      ? null
      : { content: rewritten, signatures };
  }

  const firstIndex = recentRead.content.indexOf(patchPlan.oldString);
  if (firstIndex === -1) return null;
  if (recentRead.content.indexOf(patchPlan.oldString, firstIndex + patchPlan.oldString.length) !== -1) return null;

  const rewritten = `${recentRead.content.slice(0, firstIndex)}${patchPlan.newString}${recentRead.content.slice(firstIndex + patchPlan.oldString.length)}`;
  signatures[0] = createWriteSignature(recentRead.path, rewritten);
  return rewritten === recentRead.content
    ? null
    : { content: rewritten, signatures };
}

function hasTool(availableTools: ToolDescriptor[], name: string): boolean {
  return availableTools.some((tool) => tool.name === name);
}

function inferReadPath(result: ActionResult | null): string | null {
  if (!result || !result.ok || result.action.kind !== "tool_call") return null;
  if (result.action.toolName !== "read_text_file") return null;
  const output = result.output as { path?: unknown } | null;
  return typeof output?.path === "string" && output.path.length > 0 ? output.path : null;
}

function findRecentRead(history: ActionResult[], suspectFile: string): { path: string; content: string } | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (!item || !item.ok || item.action.kind !== "tool_call") continue;
    if (item.action.toolName !== "read_text_file") continue;

    const output = item.output as { path?: unknown; content?: unknown } | null;
    if (typeof output?.path !== "string" || typeof output.content !== "string") continue;
    if (output.path !== suspectFile) continue;

    return { path: output.path, content: output.content };
  }

  return null;
}

type PatchPlan = { oldString: string; newString: string; reason?: string };

function inferEditCandidatePaths(
  workingMemory: WorkingMemorySnapshot | undefined,
  lastResult: ActionResult | null,
): string[] {
  const readPath = inferReadPath(lastResult);
  const repairPaths = inferRepairSuspectPaths(workingMemory?.validationFailure, workingMemory?.repairAttempt?.suspectFile);
  const searchedPaths = isRepairExhausted(workingMemory)
    ? rankExhaustedSearchCandidatePaths(workingMemory, [], lastResult)
    : [];
  if (readPath && searchedPaths.includes(readPath)) {
    return uniqueCompact([readPath, ...repairPaths, ...searchedPaths]);
  }
  if (readPath && repairPaths.includes(readPath)) {
    return uniqueCompact([readPath, ...repairPaths, ...searchedPaths]);
  }
  if (repairPaths.length > 0) return uniqueCompact([...repairPaths, ...searchedPaths]);
  return readPath ? [readPath] : [];
}

function isRepeatedRepairSignature(
  workingMemory: WorkingMemorySnapshot | undefined,
  _suspectFile: string,
  patchSignature: string,
): boolean {
  const repairAttempt = workingMemory?.repairAttempt;
  return !!repairAttempt
    && repairAttempt.validationFailureCount > 0
    && (repairAttempt.lastPatchSignature === patchSignature);
}

function isRepeatedStrategyPath(
  workingMemory: WorkingMemorySnapshot | undefined,
  strategy: string,
  suspectFile: string,
): boolean {
  const repairAttempt = workingMemory?.repairAttempt;
  if (!repairAttempt || repairAttempt.validationFailureCount === 0) return false;
  return repairAttempt.triedStrategyPaths?.includes(createStrategyPathKey(strategy, suspectFile)) === true;
}

function hasUntriedRepairCandidate(
  workingMemory: WorkingMemorySnapshot | undefined,
  history: ActionResult[],
): boolean {
  const repairAttempt = workingMemory?.repairAttempt;
  if (!repairAttempt) return false;
  const paths = [
    ...inferRepairSuspectPaths(workingMemory?.validationFailure, repairAttempt.suspectFile),
    ...(repairAttempt.exhaustedSearchCandidatePaths ?? []),
  ];
  return paths.some((path) => !findRecentRead(history, path));
}

function isRepairExhausted(workingMemory: WorkingMemorySnapshot | undefined): boolean {
  return workingMemory?.repairAttempt?.exhausted === true;
}

function createPatchSignature(path: string, oldString: string, newString: string): string {
  return JSON.stringify({ tool: "patch_text_file", path, oldString, newString });
}

function createWriteSignature(path: string, content: string): string {
  return JSON.stringify({ tool: "write_text_file", path, content });
}

function createExhaustedRepairFail(
  workingMemory: WorkingMemorySnapshot | undefined,
  reason: string,
): BrainDecision {
  const failure = workingMemory?.validationFailure;
  const repairAttempt = workingMemory?.repairAttempt;
  const suspectFile = failure?.suspectFile ?? repairAttempt?.suspectFile ?? "unknown";
  const failingCommands = failure?.failingCommands && failure.failingCommands.length > 0
    ? failure.failingCommands.join(", ")
    : "unknown";
  const validationFailureCount = repairAttempt?.validationFailureCount ?? 0;
  const editAttemptCount = repairAttempt?.editAttemptCount ?? 0;
  const lastStrategy = repairAttempt?.lastStrategy ?? "unknown";
  const triedStrategies = repairAttempt?.triedStrategies?.join(", ") || "none";
  const triedSuspectPaths = repairAttempt?.triedSuspectPaths?.join(", ") || "none";
  const triedStrategyPaths = repairAttempt?.triedStrategyPaths?.join(", ") || "none";
  const exhaustedSearchQuery = repairAttempt?.exhaustedSearchQuery ?? "none";
  const exhaustedSearchCandidatePaths = repairAttempt?.exhaustedSearchCandidatePaths?.join(", ") || "none";
  const exhaustedReadCandidatePaths = repairAttempt?.exhaustedReadCandidatePaths?.join(", ") || "none";

  return {
    action: {
      kind: "fail",
      reason: [
        reason,
        `suspectFile=${suspectFile}`,
        `failingCommands=${failingCommands}`,
        `validationFailureCount=${validationFailureCount}`,
        `editAttemptCount=${editAttemptCount}`,
        `lastStrategy=${lastStrategy}`,
        `triedStrategies=${triedStrategies}`,
        `triedSuspectPaths=${triedSuspectPaths}`,
        `triedStrategyPaths=${triedStrategyPaths}`,
        `exhaustedSearchQuery=${exhaustedSearchQuery}`,
        `exhaustedSearchCandidatePaths=${exhaustedSearchCandidatePaths}`,
        `exhaustedReadCandidatePaths=${exhaustedReadCandidatePaths}`,
      ].join("; "),
    },
    reasoning: "Repair loop escalation: no non-duplicate deterministic repair remains for the current suspect.",
  };
}

function inferValidationGuidedPatchPlan(
  workingMemory: WorkingMemorySnapshot | undefined,
  recentRead: { path: string; content: string } | null,
): PatchPlan | null {
  const failure = workingMemory?.validationFailure;
  if (!failure || !recentRead) return null;

  for (const line of selectPatchLineCandidates(recentRead, failure)) {
    const synthesized = inferTs2322NumberLiteralPatch(line, failure)
      ?? inferExportMismatchPatch(line, failure)
      ?? inferAssertionPatch(line, failure);

    if (!synthesized || synthesized === line) continue;
    return { oldString: line, newString: synthesized, reason: describePatchReason(line, synthesized, failure) };
  }

  return null;
}

function inferTs2322NumberLiteralPatch(
  line: string,
  failure: WorkingMemorySnapshot["validationFailure"],
): string | null {
  if (failure?.suspectErrorCode !== "TS2322") return null;
  const diagnosticText = `${failure.stderrSnippet ?? ""}\n${failure.stdoutSnippet ?? ""}`;
  if (!/Type 'string' is not assignable to type 'number'/.test(diagnosticText)) return null;

  const assignmentMatch = line.match(/^(\s*(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*:\s*number\s*=\s*)(["'])([+-]?(?:\d+|\d+\.\d+|\.\d+))\2(\s*;?\s*)$/);
  if (!assignmentMatch?.[1] || !assignmentMatch[3]) return null;

  return `${assignmentMatch[1]}${normalizeNumericLiteral(assignmentMatch[3])}${assignmentMatch[4] ?? ""}`;
}

function normalizeNumericLiteral(value: string): string {
  return value.startsWith(".") ? `0${value}` : value;
}

function inferExportMismatchPatch(
  line: string,
  failure: WorkingMemorySnapshot["validationFailure"],
): string | null {
  const exportName = failure?.suspectExportName;
  const importStyle = failure?.suspectImportStyle;
  if (!exportName || !importStyle) return null;

  const moduleSpecifier = failure.suspectFile;
  if (moduleSpecifier && isImportLine(line) && !line.includes(`"${moduleSpecifier}"`) && !line.includes(`'${moduleSpecifier}'`)) {
    return null;
  }

  if (importStyle === "default" && exportName === "default") {
    const defaultImportMatch = line.match(/^(\s*import\s+)([$A-Z_a-z][$\w]*)(\s+from\s+["'][^"']+["'];?\s*)$/);
    if (defaultImportMatch?.[1] && defaultImportMatch[2] && defaultImportMatch[3]) {
      return `${defaultImportMatch[1]}* as ${defaultImportMatch[2]}${defaultImportMatch[3]}`;
    }
  }

  if (importStyle === "named" && exportName !== "default") {
    const namedImport = escapeRegExp(exportName);
    const namedImportMatch = line.match(new RegExp(`^(\\s*import\\s+)\\{\\s*${namedImport}\\s*\\}(\\s+from\\s+["'][^"']+["'];?\\s*)$`));
    if (namedImportMatch?.[1] && namedImportMatch[2]) {
      return `${namedImportMatch[1]}${exportName}${namedImportMatch[2]}`;
    }

    const defaultFunctionExportMatch = line.match(new RegExp(`^(\\s*)export\\s+default\\s+function\\s+(${namedImport})(\\s*\\([^)]*\\).*?)$`));
    if (defaultFunctionExportMatch && defaultFunctionExportMatch[2] && defaultFunctionExportMatch[3]) {
      return `${defaultFunctionExportMatch[1] ?? ""}export function ${defaultFunctionExportMatch[2]}${defaultFunctionExportMatch[3]}`;
    }

    const defaultValueExportMatch = line.match(new RegExp(`^(\\s*)export\\s+default\\s+(${namedImport})\\s*;?\\s*$`));
    if (defaultValueExportMatch && defaultValueExportMatch[2]) {
      return `${defaultValueExportMatch[1] ?? ""}export { ${defaultValueExportMatch[2]} };`;
    }
  }

  return null;
}

function isImportLine(line: string): boolean {
  return /^\s*import\s+/.test(line);
}

function inferAssertionPatch(
  line: string,
  failure: WorkingMemorySnapshot["validationFailure"],
): string | null {
  const expected = failure?.assertExpected;
  const actual = failure?.assertActual;
  if (!expected || !actual || expected.includes("\n") || actual.includes("\n")) return null;

  const actualIndex = line.indexOf(actual);
  if (actualIndex === -1) return null;
  if (line.indexOf(actual, actualIndex + actual.length) !== -1) return null;

  return `${line.slice(0, actualIndex)}${expected}${line.slice(actualIndex + actual.length)}`;
}

function describePatchReason(
  _oldString: string,
  _newString: string,
  failure: WorkingMemorySnapshot["validationFailure"],
): string {
  if (failure?.suspectErrorCode === "TS2322") return "synthesized TS2322 number-literal fix";
  if (failure?.suspectExportName && failure.suspectImportStyle) return "synthesized import/export style fix";
  if (failure?.assertExpected && failure.assertActual) return "synthesized assertion expected-value fix";
  return "synthesized validation-guided fix";
}

function selectPatchLineCandidates(
  recentRead: { path: string; content: string },
  failure: WorkingMemorySnapshot["validationFailure"],
): string[] {
  const lines = recentRead.content.split("\n");
  const candidates: string[] = [];
  const suspectLine = failure?.suspectFile === recentRead.path ? failure.suspectLine : undefined;

  if (typeof suspectLine === "number" && suspectLine > 0) {
    const line = lines[suspectLine - 1];
    if (typeof line === "string" && line.length > 0) candidates.push(line);
  }

  for (const line of lines) {
    if (line.trim().length > 0) candidates.push(line);
  }

  return uniqueCompact(candidates);
}

function inferPlaceholderPatchPlan(
  workingMemory: WorkingMemorySnapshot | undefined,
  recentRead: { path: string; content: string } | null,
): PatchPlan | null {
  if (recentRead) {
    const line = selectReadLine(recentRead.content, workingMemory?.validationFailure?.suspectLine);
    if (line) return { oldString: line, newString: line };
  }

  const validationText = [
    workingMemory?.validationFailure?.assertDiffSummary,
    workingMemory?.validationFailure?.stderrSnippet,
    workingMemory?.validationFailure?.stdoutSnippet,
    workingMemory?.validationFailure?.summary,
    workingMemory?.lastObservation?.summary,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const fallback = validationText?.split("\n").map((line) => line.trim()).find((line) => line.length > 0);

  return fallback ? { oldString: fallback, newString: fallback } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferRepairSuspectPaths(
  failure: WorkingMemorySnapshot["validationFailure"] | undefined,
  fallbackSuspectFile?: string,
): string[] {
  const paths: string[] = [];
  if (failure?.suspectFile) paths.push(failure.suspectFile);
  if (failure?.suspectImportPath) {
    paths.push(resolveRelatedImportPath(failure.suspectFile, failure.suspectImportPath));
  }
  if (fallbackSuspectFile) paths.push(fallbackSuspectFile);
  return uniqueCompact(paths);
}

function inferExhaustedRepairSearchQuery(workingMemory: WorkingMemorySnapshot | undefined): string | null {
  const failure = workingMemory?.validationFailure;
  if (!failure) return null;

  const direct = [
    failure.suspectExportName,
    failure.suspectImportPath ? basenameWithoutExtension(failure.suspectImportPath) : undefined,
    failure.failingTestName,
    failure.suspectErrorCode ? selectErrorCodeSearchText(failure) : undefined,
    selectSummarySearchText(failure.summary),
  ].find((value): value is string => typeof value === "string" && value.trim().length >= 3);

  return direct ? normalizeSearchQuery(direct) : null;
}

function inferSearchAction(result: ActionResult | null): { query?: string } | null {
  if (!result || !result.ok || result.action.kind !== "tool_call" || result.action.toolName !== "search_workspace") return null;
  const toolInput = result.action.toolInput as { query?: unknown } | null;
  return {
    query: typeof toolInput?.query === "string" ? toolInput.query : undefined,
  };
}

function rankExhaustedSearchCandidatePaths(
  workingMemory: WorkingMemorySnapshot | undefined,
  history: ActionResult[],
  lastResult: ActionResult | null,
): string[] {
  const directPaths = inferRepairSuspectPaths(workingMemory?.validationFailure, workingMemory?.repairAttempt?.suspectFile);
  const entries = [
    ...inferSearchResultEntries(lastResult),
    ...(workingMemory?.repairAttempt?.exhaustedSearchCandidatePaths ?? []).map((file) => ({ file })),
  ];
  const uniqueEntries = uniqueCompact(entries.map((entry) => entry.file))
    .map((file) => entries.find((entry) => entry.file === file) ?? { file })
    .filter((entry) => !directPaths.includes(entry.file));

  return uniqueEntries
    .map((entry, index) => ({
      file: entry.file,
      score: scoreExhaustedSearchCandidate(entry, index, workingMemory, history),
    }))
    .sort((left, right) => right.score - left.score)
    .map((item) => item.file);
}

function inferSearchResultEntries(result: ActionResult | null): Array<{ file: string; snippet?: string }> {
  const search = inferSearchAction(result);
  if (!search) return [];
  const output = result?.output as { results?: Array<{ file?: unknown; snippet?: unknown }> } | null;
  return Array.isArray(output?.results)
    ? output.results
      .filter((item): item is { file: string; snippet?: string } => typeof item.file === "string" && item.file.length > 0)
      .map((item) => ({
        file: item.file,
        ...(typeof item.snippet === "string" ? { snippet: item.snippet } : {}),
      }))
    : [];
}

function scoreExhaustedSearchCandidate(
  entry: { file: string; snippet?: string },
  index: number,
  workingMemory: WorkingMemorySnapshot | undefined,
  history: ActionResult[],
): number {
  const failure = workingMemory?.validationFailure;
  let score = 100 - index;
  if (!/node_modules(?:\/|$)/.test(entry.file)) score += 40;
  if (!isTestPath(entry.file)) score += 25;
  else score -= 20;
  if (!findRecentRead(history, entry.file)) score += 10;
  if (!workingMemory?.repairAttempt?.triedSuspectPaths?.includes(entry.file)) score += 8;
  if (!workingMemory?.repairAttempt?.exhaustedReadCandidatePaths?.includes(entry.file)) score += 6;

  const basename = failure?.suspectImportPath ? basenameWithoutExtension(failure.suspectImportPath).toLowerCase() : "";
  const exportName = failure?.suspectExportName?.toLowerCase() ?? "";
  const haystack = `${entry.file}\n${entry.snippet ?? ""}`.toLowerCase();
  if (basename && haystack.includes(basename)) score += 20;
  if (exportName && haystack.includes(exportName)) score += 30;

  return score;
}

function isExhaustedSearchCandidatePath(workingMemory: WorkingMemorySnapshot | undefined, path: string): boolean {
  return workingMemory?.repairAttempt?.exhaustedSearchCandidatePaths?.includes(path) === true;
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?)\/|(?:\.test|\.spec)\.[A-Za-z0-9]+$/.test(path);
}

function basenameWithoutExtension(path: string): string {
  const trimmed = path.replace(/[#?].*$/, "").replace(/\/+$/, "");
  const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return basename.replace(/\.[A-Za-z0-9]+$/, "");
}

function selectErrorCodeSearchText(failure: NonNullable<WorkingMemorySnapshot["validationFailure"]>): string {
  const text = `${failure.suspectErrorCode ?? ""} ${failure.stderrSnippet ?? ""} ${failure.stdoutSnippet ?? ""}`;
  return normalizeSearchQuery(text);
}

function selectSummarySearchText(summary: string): string {
  return normalizeSearchQuery(summary);
}

function normalizeSearchQuery(value: string): string {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9_./@-]+|[^A-Za-z0-9_./@-]+$/g, ""))
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()));
  return uniqueCompact(tokens).slice(0, 5).join(" ");
}

function resolveRelatedImportPath(suspectFile: string | undefined, importPath: string): string {
  if (!suspectFile || !importPath.startsWith(".")) return importPath;
  const directory = suspectFile.includes("/") ? suspectFile.slice(0, suspectFile.lastIndexOf("/")) : "";
  return normalizePath(`${directory}/${importPath}`);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function createStrategyPathKey(strategy: string, path: string): string {
  return `${strategy}@${path}`;
}

function uniqueCompact(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function selectReadLine(content: string, suspectLine?: number): string | null {
  if (content.length === 0) return null;

  if (typeof suspectLine === "number" && suspectLine > 0) {
    const line = content.split("\n")[suspectLine - 1];
    if (typeof line === "string" && line.length > 0) return line;
  }

  return content.split("\n").find((line) => line.trim().length > 0) ?? content;
}

function summarizeObservation(lastResult: ActionResult | null, message: string): string | null {
  if (!lastResult || !lastResult.ok) return null;
  if (lastResult.action.kind !== "tool_call") return null;

  if (lastResult.action.toolName === "completion_check") {
    return summarizeCompletionCheck(lastResult.output);
  }

  if (lastResult.action.toolName === "read_text_file") {
    const output = lastResult.output as { path?: unknown; content?: unknown; truncated?: unknown } | null;
    const requestedAnswer = inferRequestedFileValueAnswer(lastResult, message, output);
    if (requestedAnswer) {
      return requestedAnswer;
    }
    if (typeof output?.path === "string") {
      const preview = typeof output.content === "string"
        ? output.content.slice(0, 240)
        : "";
      const truncatedNote = output.truncated === true ? "（已截断）" : "";
      return `已读取 ${output.path}${truncatedNote}。预览：\n${preview}`;
    }
  }

  if (lastResult.action.toolName === "search_workspace") {
    const output = lastResult.output as { results?: Array<{ file?: unknown; line?: unknown }> } | null;
    const top = output?.results?.[0];
    if (typeof top?.file === "string") {
      const linePart = typeof top.line === "number" ? `:${top.line}` : "";
      return `已找到一个高相关匹配：${top.file}${linePart}。下一步应该继续读取它。`;
    }
  }

  if (lastResult.action.toolName === "web_search") {
    const output = lastResult.output as {
      query?: unknown;
      provider?: unknown;
      results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>;
    } | null;
    const query = typeof output?.query === "string" ? output.query : message.trim();
    const provider = typeof output?.provider === "string" ? `（${output.provider}）` : "";
    const results = Array.isArray(output?.results) ? output.results : [];
    if (results.length === 0) {
      return `我已联网搜索${provider}「${query}」，但没有拿到可用结果。可以换个关键词，或者让我抓取你指定的网页链接。`;
    }
    const lines = results.slice(0, 5).map((item, index) => {
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "未命名结果";
      const url = typeof item.url === "string" && item.url.trim() ? item.url.trim() : "";
      const snippet = typeof item.snippet === "string" && item.snippet.trim() ? `\n   ${item.snippet.trim()}` : "";
      return `${index + 1}. ${title}${url ? `\n   ${url}` : ""}${snippet}`;
    });
    return `我已联网搜索${provider}「${query}」，找到这些结果：\n${lines.join("\n")}`;
  }

  if (lastResult.action.toolName === "web_fetch") {
    const output = lastResult.output as {
      url?: unknown;
      title?: unknown;
      text?: unknown;
      content?: unknown;
      htmlPreview?: unknown;
      truncated?: unknown;
      htmlPreviewTruncated?: unknown;
    } | null;
    const url = typeof output?.url === "string" ? output.url : "该网页";
    const title = typeof output?.title === "string" && output.title.trim() ? `「${output.title.trim()}」` : "";
    const content = typeof output?.text === "string"
      ? output.text
      : typeof output?.content === "string"
        ? output.content
        : typeof output?.htmlPreview === "string"
          ? output.htmlPreview
          : "";
    const preview = content.trim().slice(0, 700);
    const truncatedNote = output?.truncated === true || output?.htmlPreviewTruncated === true || content.length > 700
      ? "\n\n内容较长，我先截取了前半部分；需要的话我可以继续抓取/整理。"
      : "";
    const fallback = typeof output?.htmlPreview === "string" && output.htmlPreview.trim()
      ? `没有提取到明显正文，但页面返回了 HTML 预览：\n${output.htmlPreview.trim().slice(0, 700)}`
      : "页面已返回，但没有提取到明显正文。";
    return `我已抓取网页${title}：${url}\n\n${preview || fallback}${truncatedNote}`;
  }

  return null;
}

function summarizeCompletionCheck(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const data = output as {
    status?: unknown;
    repeatedActionPrevented?: unknown;
    action?: { target?: unknown; label?: unknown; toolName?: unknown };
    validation?: { ok?: unknown; summary?: unknown } | null;
  };
  const target = typeof data.action?.target === "string" ? data.action.target : null;
  const label = typeof data.action?.label === "string" ? data.action.label : "处理";
  const repeatedActionPrevented = data.repeatedActionPrevented !== false;
  const validationSummary = typeof data.validation?.summary === "string" && data.validation.summary.trim()
    ? data.validation.summary.trim()
    : data.validation?.ok === true
      ? "验证已通过。"
      : data.validation?.ok === false
        ? "验证未通过。"
        : "检查已完成。";

  if (data.status === "needs_repair") {
    if (!repeatedActionPrevented) {
      return target
        ? `${target} 已${label}，但后续检查没有通过：${validationSummary} 我会换一种修复方式继续。`
        : `工具动作已经执行，但后续检查没有通过：${validationSummary} 我会换一种修复方式继续。`;
    }
    return target
      ? `我已经完成了 ${target} 的${label}，但后续检查没有通过：${validationSummary} 我会停止重复同一个写入动作，需要换一种修复方式继续。`
      : `工具动作已经执行，但后续检查没有通过：${validationSummary} 我会停止重复同一个写入动作，需要换一种修复方式继续。`;
  }

  if (!repeatedActionPrevented) {
    return target
      ? `工作已完成：${target} 已${label}，并且${validationSummary}`
      : `工作已完成，后续检查结果：${validationSummary}`;
  }

  return target
    ? `工作已完成：${target} 已${label}，并且${validationSummary}`
    : `工作已完成，后续检查结果：${validationSummary}`;
}

function inferRequestedFileValueAnswer(
  lastResult: ActionResult,
  message: string,
  output: { path?: unknown; content?: unknown; truncated?: unknown } | null,
): string | null {
  if (!/\b(file|value|answer|secret)\b/i.test(message)) return null;
  if (typeof output?.content !== "string") return null;

  const toolInput = lastResult.action.toolInput as { path?: unknown } | null;
  const path = typeof toolInput?.path === "string"
    ? toolInput.path
    : typeof output?.path === "string"
      ? output.path
      : null;
  if (!path) return null;

  const labeledValue = extractLabeledValue(output.content);
  if (labeledValue) {
    return `已找到答案，文件在 ${path}：${labeledValue.label} = ${labeledValue.value}`;
  }

  const focusedLine = selectReadLine(output.content);
  if (!focusedLine) return null;
  return `已找到答案，文件在 ${path}：${focusedLine.trim()}`;
}

function extractLabeledValue(content: string): { label: string; value: string } | null {
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{1,40})\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const [, rawLabel = "", rawValue = ""] = match;
    const label = rawLabel.trim();
    const value = rawValue.trim();
    if (!value) continue;
    if (/\b(answer|secret|value|token|key|code)\b/i.test(label)) {
      return { label, value };
    }
  }
  return null;
}

const STOP_WORDS = new Set([
  "please", "the", "this", "that", "with", "from", "into", "after", "before", "there", "their", "error",
  "validation", "file", "code", "need", "help", "make", "just", "should", "would",
  "find", "search", "read", "show", "tell", "workspace", "value", "locate", "lookup", "inspect",
]);

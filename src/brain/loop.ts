import type {
  BrainInput,
  BrainDecision,
  ActionResult,
  ActionResultCategory,
  TaskLoopCriterionStatus,
  PlannerPhase,
  TaskLoopPlanStatus,
  WorkingMemorySnapshot,
} from "./types.js";
import type { Planner } from "./planner.js";
import type { Policy } from "./policy.js";
import type { Evaluator, LoopStopReason } from "./evaluator.js";
import type { ToolExecutionContext, ValidationModeHint } from "../tools/types.js";
import { addUsageToRunUsage, emptyRunTokenUsage, type LlmTokenUsage, type RunTokenUsage } from "./usage.js";
import { judgeTaskCompletion } from "./completion.js";

export interface LoopDeps {
  planner: Planner;
  policy: Policy;
  dispatcher: {
    dispatch(decision: BrainDecision, context?: ToolExecutionContext): Promise<ActionResult>;
  };
  evaluator: Evaluator;
}

export interface LoopContext {
  signal?: AbortSignal;
  initialUsage?: RunTokenUsage;
  usageBudget?: {
    maxModelRequests?: number;
    maxTotalTokens?: number;
    maxPromptEstimateTokens?: number;
  };
  onUsage?(usage: LlmTokenUsage, total: RunTokenUsage): Promise<void> | void;
  onTaskLoop?(
    workingMemory: WorkingMemorySnapshot,
    event: {
      step: number;
      phase: "initialized" | "advanced" | "checkpoint" | "finalized";
      summary: string;
      result?: ActionResult;
    },
  ): Promise<void> | void;
}

export interface LoopState {
  steps: number;
  history: ActionResult[];
  workingMemory: WorkingMemorySnapshot;
  lastDecision: BrainDecision | null;
  lastResult: ActionResult | null;
  stopReason: LoopStopReason | null;
  stopSummary: string | null;
  usage: RunTokenUsage;
}

const MAX_REPAIR_VALIDATION_FAILURES_PER_SUSPECT = 2;
const MAX_REPAIR_ATTEMPT_HISTORY = 6;
const DEFAULT_USAGE_BUDGET = {
  maxModelRequests: 32,
  maxTotalTokens: 180_000,
  maxPromptEstimateTokens: 220_000,
};
const MAX_TASK_LOOP_EVIDENCE_LOG = 12;

type TaskLoopEvidenceLogEntry = NonNullable<NonNullable<WorkingMemorySnapshot["taskLoop"]>["evidenceLog"]>[number];
type TaskLoopSelfCheck = NonNullable<NonNullable<WorkingMemorySnapshot["taskLoop"]>["selfCheck"]>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function createInitialWorkingMemory(input: BrainInput, resetForNewTask = shouldStartFreshTaskLoop(input)): WorkingMemorySnapshot {
  const initial: WorkingMemorySnapshot = {
    // 所有 run 默认从 investigate 起步；resume 时再由外部注入已有 workingMemory 覆盖。
    phase: "investigate",
    step: 0,
    taskLoop: createInitialTaskLoop(input),
    lastActionKind: null,
  };
  if (!input.workingMemory || resetForNewTask) return initial;
  return {
    ...initial,
    ...input.workingMemory,
    taskLoop: input.workingMemory.taskLoop ?? initial.taskLoop,
  };
}

function createInitialTaskLoop(input: BrainInput): NonNullable<WorkingMemorySnapshot["taskLoop"]> {
  const objective = latestUserMessage(input).trim();
  const mode = inferTaskLoopMode(objective);
  return {
    objective: objective || "Continue the current task.",
    mode,
    evidenceCount: 0,
    completionGateCount: 0,
    currentStep: "collect_evidence",
    plan: createTaskLoopPlan(mode),
    currentTaskId: "collect_evidence",
    tasks: createTaskLoopTasks(mode),
    needsFinalAnswer: false,
  };
}

function shouldStartFreshTaskLoop(input: BrainInput): boolean {
  const previous = input.workingMemory?.taskLoop;
  if (!previous) return false;
  const message = latestUserMessage(input).trim();
  if (!message || isContinuationTaskMessage(message)) return false;

  const previousObjective = normalizeTaskObjective(previous.objective);
  const nextObjective = normalizeTaskObjective(message);
  if (!nextObjective || nextObjective === previousObjective) return false;

  const previousMode = previous.mode;
  const nextMode = inferTaskLoopMode(message);
  if (nextMode !== "chat" && nextMode !== previousMode) return true;

  const previousAnchor = extractTaskAnchor(previous.objective) ?? previous.lastEvidenceTarget ?? "";
  const nextAnchor = extractTaskAnchor(message);
  if (nextAnchor && !normalizeTaskObjective(previousAnchor).includes(normalizeTaskObjective(nextAnchor))) return true;

  return isLikelyStandaloneTaskMessage(message) && previous.needsFinalAnswer !== true;
}

function isContinuationTaskMessage(message: string): boolean {
  const text = message.trim().toLowerCase();
  return /^(继续|接着|上次|继续上次|接着上次|从这里|继续刚才|继续之前|resume|continue)/i.test(text)
    || /继续上次|接着上次|上次暂停|上一轮|从 checkpoint|from checkpoint/i.test(text);
}

function isLikelyStandaloneTaskMessage(message: string): boolean {
  return message.length >= 8
    && /看一下|分析|修|改|写|创建|生成|搜索|联网|打开|抓取|读取|总结|检查|运行|测试|打包|提交|push|release|url|https?:\/\//i.test(message);
}

function normalizeTaskObjective(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function extractTaskAnchor(message: string): string | null {
  const url = message.match(/https?:\/\/\S+/i)?.[0];
  if (url) return url.replace(/[，。),\]>]+$/, "");
  const windowsPath = message.match(/[A-Za-z]:\\[^\s，。]+/)?.[0];
  if (windowsPath) return windowsPath;
  const filePath = message.match(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|html|css|yaml|yml|dart|rs|go|java|cpp|c|h)/i)?.[0];
  return filePath ?? null;
}

function createTaskLoopPlan(
  mode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"] {
  if (mode === "web") {
    return [
      { id: "collect_evidence", title: "定位网页来源", status: "active" },
      { id: "analyze_evidence", title: "提取正文证据", status: "pending" },
      { id: "answer", title: "基于网页证据回答", status: "pending" },
    ];
  }

  if (mode === "edit" || mode === "validation") {
    return [
      { id: "collect_evidence", title: "确认目标和诊断", status: "active" },
      { id: "apply_change", title: "执行一次聚焦修改", status: "pending" },
      { id: "verify", title: "验证修改结果", status: "pending" },
      { id: "answer", title: "总结结果和风险", status: "pending" },
    ];
  }

  if (mode === "workspace") {
    return [
      { id: "collect_evidence", title: "查看项目结构", status: "active" },
      { id: "analyze_evidence", title: "读取关键文件", status: "pending" },
      { id: "answer", title: "基于已检查内容说明", status: "pending" },
    ];
  }

  return [
    { id: "collect_evidence", title: "理解当前请求", status: "active" },
    { id: "answer", title: "直接回复", status: "pending" },
  ];
}

function createTaskLoopTasks(
  mode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["tasks"] {
  if (mode === "web") {
    return [
      taskLoopTask("collect_evidence", "定位网页来源", ["source_located"], ["web_fetch", "web_search", "web_extract_links"], "active"),
      taskLoopTask("analyze_evidence", "提取可读正文或候选内容", ["body_evidence"], ["web_fetch", "web_extract_links"], "pending", ["collect_evidence"]),
      taskLoopTask("answer", "基于搜索或抓取证据回答", ["final_feedback"], [], "pending", ["analyze_evidence"]),
    ];
  }

  if (mode === "edit" || mode === "validation") {
    return [
      taskLoopTask("collect_evidence", "检查目标文件或失败诊断", ["target_evidence"], ["read_text_file", "read_many_files", "search_workspace", "collect_diagnostics"], "active"),
      taskLoopTask("apply_change", "执行一次聚焦的工作区修改", ["workspace_mutated"], ["patch_text_file", "write_text_file"], "pending", ["collect_evidence"]),
      taskLoopTask("verify", "验证修改后的工作区", ["validation_passed"], ["run_validation"], "pending", ["apply_change"]),
      taskLoopTask("answer", "汇报修改内容和验证结果", ["final_feedback"], [], "pending", ["verify"]),
    ];
  }

  if (mode === "workspace") {
    return [
      taskLoopTask("collect_evidence", "检查项目结构和相关路径", ["structure_evidence"], ["inspect_project", "list_directory", "search_workspace"], "active"),
      taskLoopTask("analyze_evidence", "读取关键文件或生成代码地图", ["key_file_evidence"], ["read_many_files", "read_text_file", "code_map"], "pending", ["collect_evidence"]),
      taskLoopTask("answer", "基于已检查证据说明结论", ["final_feedback"], [], "pending", ["analyze_evidence"]),
    ];
  }

  return [
    taskLoopTask("collect_evidence", "理解当前请求", ["request_understood"], [], "active"),
    taskLoopTask("answer", "直接回复用户", ["final_feedback"], [], "pending", ["collect_evidence"]),
  ];
}

function taskLoopTask(
  id: string,
  title: string,
  criteriaIds: string[],
  toolHints: string[],
  status: TaskLoopPlanStatus = "pending",
  dependsOn: string[] = [],
): NonNullable<NonNullable<WorkingMemorySnapshot["taskLoop"]>["tasks"]>[number] {
  return {
    id,
    title,
    status,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    criteria: criteriaIds.map((criterionId) => ({
      id: criterionId,
      description: describeTaskCriterion(criterionId),
      status: "pending" as TaskLoopCriterionStatus,
    })),
    ...(toolHints.length > 0 ? { toolHints } : {}),
    attempts: 0,
  };
}

function describeTaskCriterion(id: string): string {
  const descriptions: Record<string, string> = {
    source_located: "已定位用户请求的 URL 或搜索结果。",
    body_evidence: "已拿到可读正文、文章候选内容或有用的 HTML 预览。",
    target_evidence: "编辑前已检查目标文件、诊断信息或附近代码。",
    workspace_mutated: "工作区修改已成功执行。",
    validation_passed: "相关验证或检查已成功通过。",
    structure_evidence: "已观察项目结构或相关工作区路径。",
    key_file_evidence: "已收集关键文件或代码地图证据。",
    request_understood: "已理解用户当前请求。",
    final_feedback: "已产出面向用户的最终反馈。",
  };
  return descriptions[id] ?? id;
}

function observationCategory(result: ActionResult): ActionResultCategory {
  return result.metadata?.category ?? (result.ok ? "tool_observation" : "runtime_error");
}

function observationSummary(result: ActionResult): string {
  if (result.metadata?.summary) {
    return result.metadata.summary;
  }

  if (result.error) {
    return result.error;
  }

  if (typeof result.output === "string") {
    return result.output.slice(0, 500);
  }

  return (JSON.stringify(result.output) ?? "").slice(0, 500);
}

function updateTaskLoop(
  previous: WorkingMemorySnapshot,
  result: ActionResult,
  toolName: string | undefined,
  step: number,
): WorkingMemorySnapshot["taskLoop"] | undefined {
  const current = previous.taskLoop;
  if (!current) return undefined;

  const evidence = inferTaskLoopEvidence(result, toolName);
  const evidenceLogEntry = inferTaskLoopEvidenceLogEntry(result, toolName, step);
  const isFinalAction = result.action.kind === "respond" || result.action.kind === "finish" || result.action.kind === "fail";
  const evidenceCount = evidence && result.ok ? current.evidenceCount + 1 : current.evidenceCount;
  const completionGateCount = toolName === "completion_check"
    ? current.completionGateCount + 1
    : current.completionGateCount;
  const nextMode = inferTaskLoopModeFromResult(current.mode, result, toolName);
  const basePlan = nextMode === current.mode
    ? current.plan ?? createTaskLoopPlan(nextMode)
    : createTaskLoopPlan(nextMode);
  const nextPlan = updateTaskLoopPlan(basePlan, result, toolName);
  const baseTasks = nextMode === current.mode
    ? current.tasks ?? createTaskLoopTasks(nextMode)
    : createTaskLoopTasks(nextMode);
  const nextTasks = updateTaskLoopTasks(baseTasks, result, toolName);
  const evidenceLog = appendTaskLoopEvidenceLog(current.evidenceLog, evidenceLogEntry);
  const selfCheck = buildTaskLoopSelfCheck(nextMode, nextTasks, result, evidenceLog, step);

  return {
    ...current,
    mode: nextMode,
    evidenceCount,
    completionGateCount,
    plan: nextPlan,
    currentStep: inferCurrentTaskLoopStep(nextPlan),
    tasks: nextTasks,
    currentTaskId: inferCurrentTaskLoopTask(nextTasks),
    evidenceLog,
    selfCheck,
    ...(evidence?.kind ? { lastEvidenceKind: evidence.kind } : {}),
    ...(evidence?.tool ? { lastEvidenceTool: evidence.tool } : {}),
    ...(evidence?.target ? { lastEvidenceTarget: evidence.target } : {}),
    ...(evidence?.summary ? { lastProgressSummary: evidence.summary } : {}),
    needsFinalAnswer: isFinalAction ? false : selfCheck.status === "passed",
  };
}

type TaskLoopTask = NonNullable<NonNullable<WorkingMemorySnapshot["taskLoop"]>["tasks"]>[number];

function updateTaskLoopTasks(
  tasks: TaskLoopTask[] | undefined,
  result: ActionResult,
  toolName: string | undefined,
): TaskLoopTask[] | undefined {
  if (!tasks) return tasks;
  const activeTaskId = inferCurrentTaskLoopTask(tasks) ?? tasks.find((task) => task.status === "pending")?.id;
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const summary = observationSummary(result).slice(0, 420);

  if (result.action.kind === "fail" || !result.ok || (toolName === "run_validation" && validationDidFail(result))) {
    const blocked = tasks.map((task) => task.id === activeTaskId
      ? markTaskBlocked(task, summary)
      : task);
    return activateNextTask(blocked);
  }

  const satisfiedCriteria = taskCriteriaSatisfiedByResult(result, toolName, activeTask);
  if (satisfiedCriteria.length === 0) return activateNextTask(tasks);

  const updated = tasks.map((task) => {
    const criteria = task.criteria.map((criterion) => satisfiedCriteria.includes(criterion.id)
      ? { ...criterion, status: "satisfied" as TaskLoopCriterionStatus, evidence: summary }
      : criterion);
    const touched = task.criteria.some((criterion) => satisfiedCriteria.includes(criterion.id));
    if (!touched) return task;
    const done = criteria.every((criterion) => criterion.status === "satisfied");
    return {
      ...task,
      criteria,
      attempts: task.attempts + 1,
      lastSummary: summary,
      status: done ? "done" as TaskLoopPlanStatus : task.status,
    };
  });
  return activateNextTask(updated);
}

function markTaskBlocked(task: TaskLoopTask, summary: string): TaskLoopTask {
  return {
    ...task,
    status: "blocked",
    attempts: task.attempts + 1,
    lastSummary: summary,
    criteria: task.criteria.map((criterion) => criterion.status === "pending"
      ? { ...criterion, status: "failed" as TaskLoopCriterionStatus, evidence: summary }
      : criterion),
  };
}

function taskCriteriaSatisfiedByResult(result: ActionResult, toolName: string | undefined, activeTask?: TaskLoopTask): string[] {
  if (result.action.kind === "respond" || result.action.kind === "finish") return ["final_feedback"];
  if (result.action.kind !== "tool_call" || !toolName) return [];
  if (result.metadata?.workspaceMutation === true) return ["target_evidence", "workspace_mutated"];
  if (toolName === "completion_check") return ["validation_passed"];
  if (toolName === "run_validation" && !validationDidFail(result)) return ["validation_passed"];
  if (toolName === "web_search") return ["source_located"];
  if (toolName === "web_extract_links") return hasTaskLoopExtractedLinks(result.output) ? ["source_located"] : [];
  if (toolName === "web_fetch") {
    return hasTaskLoopWebBodyEvidence(result.output)
      ? ["source_located", "body_evidence"]
      : ["source_located"];
  }
  if (toolName === "read_text_file" || toolName === "read_many_files" || toolName === "code_map" || toolName === "dependency_graph" || toolName === "symbol_search") {
    return ["structure_evidence", "target_evidence", "key_file_evidence"];
  }
  if (toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") {
    const satisfied = ["structure_evidence"];
    if (activeTaskHasCriterion(activeTask, "target_evidence") && hasTaskLoopRecoveryTargetEvidence(result.output, toolName)) {
      satisfied.push("target_evidence");
    }
    return satisfied;
  }
  return [];
}

function activeTaskHasCriterion(activeTask: TaskLoopTask | undefined, criterionId: string): boolean {
  return activeTask?.criteria.some((criterion) => criterion.id === criterionId && criterion.status !== "satisfied") === true;
}

function hasTaskLoopRecoveryTargetEvidence(output: unknown, toolName: string): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  if (toolName === "search_workspace") {
    return Array.isArray(record.results) && record.results.length > 0;
  }
  if (toolName === "list_directory" || toolName === "inspect_project") {
    const entries = Array.isArray(record.entries)
      ? record.entries
      : Array.isArray(record.topLevelEntries)
        ? record.topLevelEntries
        : [];
    return entries.length > 0;
  }
  return false;
}

function hasTaskLoopExtractedLinks(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const links = (output as { links?: unknown }).links;
  return Array.isArray(links) && links.length > 0;
}

function hasTaskLoopWebBodyEvidence(output: unknown): boolean {
  if (isTaskLoopReadableArticleText(output, 160)) return true;
  if (!output || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  for (const key of ["text", "content", "markdown"]) {
    const value = record[key];
    if (isTaskLoopReadableArticleText(value, 160)) return true;
  }
  const candidates = record.articleCandidates;
  if (Array.isArray(candidates)) {
    return candidates.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const text = (candidate as Record<string, unknown>).text;
      return isTaskLoopReadableArticleText(text, 160);
    });
  }
  return false;
}

function isTaskLoopReadableArticleText(value: unknown, minLength: number): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < minLength) return false;
  const boilerplateHits = [
    /下载.*客户端/,
    /扫码|二维码|APP|广告|举报|评论|分享/,
    /关注.*公众号/,
    /copyright|版权所有|ICP备案/i,
  ].filter((pattern) => pattern.test(text)).length;
  const paragraphLike = text.split(/\n+/).filter((line) => line.trim().length >= 20).length;
  return boilerplateHits < 2 || paragraphLike >= 2;
}

function activateNextTask(tasks: TaskLoopTask[]): TaskLoopTask[] {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  if (tasks.some((task) => task.status === "active" || task.status === "blocked")) return tasks;
  const next = tasks.find((task) => task.status === "pending" && taskDependenciesDone(task, taskMap));
  if (!next) return tasks;
  return tasks.map((task) => task.id === next.id ? { ...task, status: "active" as TaskLoopPlanStatus } : task);
}

function taskDependenciesDone(task: TaskLoopTask, taskMap: Map<string, TaskLoopTask>): boolean {
  return (task.dependsOn ?? []).every((dependencyId) => taskMap.get(dependencyId)?.status === "done");
}

function inferCurrentTaskLoopTask(tasks: TaskLoopTask[] | undefined): string | undefined {
  return tasks?.find((task) => task.status === "active" || task.status === "blocked")?.id
    ?? tasks?.find((task) => task.id === "answer" && task.status === "done")?.id;
}

function updateTaskLoopPlan(
  plan: NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"],
  result: ActionResult,
  toolName: string | undefined,
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"] {
  if (!plan) return plan;
  if (result.action.kind === "fail") return setActivePlanStatus(plan, "blocked");
  if (result.action.kind === "respond" || result.action.kind === "finish") return markPlanThrough(plan, "answer");
  if (!result.ok) return setActivePlanStatus(plan, "blocked");

  if (result.metadata?.workspaceMutation === true) return markPlanThrough(plan, "apply_change");
  if (toolName === "run_validation" || toolName === "completion_check") return markPlanThrough(plan, "verify");
  if (toolName === "web_fetch" || toolName === "read_text_file" || toolName === "read_many_files" || toolName === "code_map") return markPlanThrough(plan, "analyze_evidence");
  if (toolName === "web_search" || toolName === "web_extract_links" || toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") {
    return markPlanThrough(plan, "collect_evidence");
  }

  return plan;
}

function markPlanThrough(
  plan: NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"],
  completedId: string,
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"] {
  if (!plan) return plan;
  const completedIndex = plan.findIndex((item) => item.id === completedId);
  if (completedIndex < 0) return plan;
  const nextIndex = plan.findIndex((item, index) => index > completedIndex && item.status !== "done");
  return plan.map((item, index) => {
    if (index <= completedIndex) return { ...item, status: "done" as TaskLoopPlanStatus };
    if (index === nextIndex) return { ...item, status: "active" as TaskLoopPlanStatus };
    return item.status === "done" ? item : { ...item, status: "pending" as TaskLoopPlanStatus };
  });
}

function setActivePlanStatus(
  plan: NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"],
  status: TaskLoopPlanStatus,
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"] {
  return plan?.map((item) => item.status === "active" ? { ...item, status } : item);
}

function inferCurrentTaskLoopStep(plan: NonNullable<WorkingMemorySnapshot["taskLoop"]>["plan"]): string | undefined {
  return plan?.find((item) => item.status === "active")?.id
    ?? plan?.find((item) => item.id === "answer" && item.status === "done")?.id;
}

function inferTaskLoopMode(message: string): NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"] {
  const text = message.toLowerCase();
  const searchIntent = /搜|搜索|查一下|查询|查找|检索|look up|search|find/.test(text);
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory/.test(text);
  if (
    /https?:\/\//.test(text)
    || /联网|上网|网上|网页|网址|链接|文章|正文|抓取|官网|新闻|资料|文档|url|github|release|最新|最近|当前|recent|latest|news|online|web/.test(text)
    || (searchIntent && !localIntent)
  ) return "web";
  if (/修|改|写|删|创建|生成|保存|提交|push|commit|build|打包|安装包|release/.test(text)) return "edit";
  if (/验证|测试|运行|报错|error|fail|test|typecheck|lint/.test(text)) return "validation";
  if (extractTaskAnchor(message)) return "workspace";
  if (/项目|工程|目录|文件|代码|workspace|repo|仓库|path|路径/.test(text)) return "workspace";
  return "chat";
}

function inferTaskLoopModeFromResult(
  currentMode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
  result: ActionResult,
  toolName: string | undefined,
): NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"] {
  if (result.metadata?.workspaceMutation === true) return "edit";
  if (toolName === "run_validation") return "validation";
  if (toolName === "web_search" || toolName === "web_fetch" || toolName === "web_extract_links") return "web";
  if (toolName === "read_text_file" || toolName === "read_many_files" || toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") {
    if (currentMode === "edit" || currentMode === "validation") return currentMode;
    return currentMode === "web" ? "web" : "workspace";
  }
  return currentMode;
}

function inferTaskLoopEvidence(
  result: ActionResult,
  toolName: string | undefined,
): {
  kind: NonNullable<WorkingMemorySnapshot["taskLoop"]>["lastEvidenceKind"];
  tool: string;
  target?: string;
  summary?: string;
} | null {
  if (result.action.kind !== "tool_call" || !toolName) return null;
  if (result.metadata?.category === "tool_error") return null;

  const kind = inferTaskLoopEvidenceKind(toolName);
  const target = inferTaskLoopTarget(result);
  const summary = observationSummary(result).slice(0, 420);
  return {
    kind,
    tool: toolName,
    ...(target ? { target } : {}),
    ...(summary ? { summary } : {}),
  };
}

function inferTaskLoopEvidenceLogEntry(
  result: ActionResult,
  toolName: string | undefined,
  step: number,
): TaskLoopEvidenceLogEntry | null {
  if (result.action.kind !== "tool_call" || !toolName) return null;
  const kind = inferTaskLoopEvidenceKind(toolName);
  const target = inferTaskLoopTarget(result);
  const summary = observationSummary(result).replace(/\s+/g, " ").trim().slice(0, 520)
    || (result.ok ? `${toolName} completed.` : `${toolName} failed.`);

  return {
    step,
    toolName,
    kind,
    quality: inferTaskLoopEvidenceQuality(result, toolName),
    ...(target ? { target } : {}),
    summary,
  };
}

function appendTaskLoopEvidenceLog(
  current: TaskLoopEvidenceLogEntry[] | undefined,
  entry: TaskLoopEvidenceLogEntry | null,
): TaskLoopEvidenceLogEntry[] | undefined {
  if (!entry) return current;
  return [...(current ?? []), entry].slice(-MAX_TASK_LOOP_EVIDENCE_LOG);
}

function buildTaskLoopSelfCheck(
  mode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
  tasks: TaskLoopTask[] | undefined,
  result: ActionResult,
  evidenceLog: TaskLoopEvidenceLogEntry[] | undefined,
  step: number,
): TaskLoopSelfCheck {
  const latestEvidence = evidenceLog?.[evidenceLog.length - 1];
  const missingCriteria = collectMissingTaskLoopCriteria(tasks);
  const failedCriteria = collectFailedTaskLoopCriteria(tasks);

  if (!result.ok || result.action.kind === "fail" || (result.action.toolName === "run_validation" && validationDidFail(result))) {
    return {
      status: "needs_repair",
      summary: `Latest action did not complete cleanly; recover before final feedback.`,
      checkedAtStep: step,
      ...(failedCriteria.length > 0 ? { missingCriteria: failedCriteria } : {}),
      ...(latestEvidence?.quality ? { latestEvidenceQuality: latestEvidence.quality } : {}),
    };
  }

  if (missingCriteria.length > 0) {
    return {
      status: "needs_evidence",
      summary: `Task still needs evidence for: ${missingCriteria.join(", ")}.`,
      checkedAtStep: step,
      missingCriteria,
      ...(latestEvidence?.quality ? { latestEvidenceQuality: latestEvidence.quality } : {}),
    };
  }

  if (!hasStrongCompletionEvidenceForMode(mode, evidenceLog)) {
    return {
      status: "needs_evidence",
      summary: `Checklist is complete, but the latest evidence is not strong enough for ${mode} final feedback.`,
      checkedAtStep: step,
      missingCriteria: ["strong_completion_evidence"],
      ...(latestEvidence?.quality ? { latestEvidenceQuality: latestEvidence.quality } : {}),
    };
  }

  return {
    status: "passed",
    summary: `Task checklist and evidence quality passed for ${mode} final feedback.`,
    checkedAtStep: step,
    ...(latestEvidence?.quality ? { latestEvidenceQuality: latestEvidence.quality } : {}),
  };
}

function collectMissingTaskLoopCriteria(tasks: TaskLoopTask[] | undefined): string[] {
  if (!tasks) return [];
  return tasks
    .filter((task) => task.id !== "answer")
    .flatMap((task) => task.criteria)
    .filter((criterion) => criterion.status !== "satisfied")
    .map((criterion) => criterion.id);
}

function collectFailedTaskLoopCriteria(tasks: TaskLoopTask[] | undefined): string[] {
  if (!tasks) return [];
  return tasks
    .flatMap((task) => task.criteria)
    .filter((criterion) => criterion.status === "failed")
    .map((criterion) => criterion.id);
}

function hasStrongCompletionEvidenceForMode(
  mode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
  evidenceLog: TaskLoopEvidenceLogEntry[] | undefined,
): boolean {
  const evidence = evidenceLog ?? [];
  if (mode === "chat") return true;
  if (mode === "web") return evidence.some((entry) => entry.kind === "web" && entry.toolName === "web_fetch" && entry.quality === "strong");
  if (mode === "workspace") {
    return evidence.some((entry) => (entry.kind === "file" || entry.kind === "code") && entry.quality === "strong");
  }
  if (mode === "edit" || mode === "validation") {
    return evidence.some((entry) => (entry.toolName === "run_validation" || entry.toolName === "completion_check") && entry.quality === "strong");
  }
  return evidence.some((entry) => entry.quality === "strong");
}

function inferTaskLoopEvidenceQuality(
  result: ActionResult,
  toolName: string,
): TaskLoopEvidenceLogEntry["quality"] {
  if (!result.ok || result.metadata?.category === "tool_error") return "failed";
  if (result.metadata?.workspaceMutation === true) return "strong";
  if (toolName === "run_validation" || toolName === "completion_check") {
    return validationDidFail(result) ? "failed" : "strong";
  }
  if (toolName === "web_fetch") return hasTaskLoopWebBodyEvidence(result.output) ? "strong" : "weak";
  if (toolName === "web_search") return hasTaskLoopSearchResults(result.output) ? "strong" : "weak";
  if (toolName === "web_extract_links") return hasTaskLoopExtractedLinks(result.output) ? "strong" : "weak";
  if (toolName === "read_text_file") return hasTaskLoopReadableFileContent(result.output) ? "strong" : "weak";
  if (toolName === "read_many_files") return hasTaskLoopReadableManyFileContent(result.output) ? "strong" : "weak";
  if (toolName === "code_map" || toolName === "dependency_graph" || toolName === "symbol_search") return "strong";
  if (toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") {
    return hasTaskLoopRecoveryTargetEvidence(result.output, toolName) ? "strong" : "weak";
  }
  return "weak";
}

function hasTaskLoopSearchResults(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const results = (output as { results?: unknown }).results;
  return Array.isArray(results) && results.length > 0;
}

function hasTaskLoopReadableFileContent(output: unknown): boolean {
  if (typeof output === "string") return output.trim().length > 0;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const content = (output as { content?: unknown; text?: unknown }).content ?? (output as { text?: unknown }).text;
  return typeof content === "string" && content.trim().length > 0;
}

function hasTaskLoopReadableManyFileContent(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const files = (output as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  return files.some((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) return false;
    const record = file as { ok?: unknown; content?: unknown };
    return record.ok === true && typeof record.content === "string" && record.content.trim().length > 0;
  });
}

function inferTaskLoopEvidenceKind(
  toolName: string,
): TaskLoopEvidenceLogEntry["kind"] {
  if (toolName === "web_search" || toolName === "web_fetch" || toolName === "web_extract_links") return "web";
  if (toolName === "read_text_file" || toolName === "read_many_files") return "file";
  if (toolName === "code_map" || toolName === "dependency_graph" || toolName === "symbol_search") return "code";
  if (toolName === "run_validation" || toolName === "completion_check") return "validation";
  if (toolName === "terminal_command") return "terminal";
  if (toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") return "workspace";
  return "unknown";
}

function inferTaskLoopTarget(result: ActionResult): string | null {
  const inputTarget = inferWorkspaceActionTarget(result.action);
  if (inputTarget) return inputTarget;
  const input = result.action.toolInput as Record<string, unknown> | null;
  for (const key of ["url", "query", "cwd", "command"]) {
    if (typeof input?.[key] === "string" && input[key].length > 0) return input[key] as string;
  }
  return inferOutputPath(result.output);
}

function updateWorkingMemory(
  previous: WorkingMemorySnapshot,
  step: number,
  result: ActionResult,
): WorkingMemorySnapshot {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  const isRetryableToolError = result.metadata?.category === "tool_error"
    && result.metadata.retryable === true
    && typeof toolName === "string";
  const validationFailure = inferValidationFailure(result);
  const repairAttempt = updateRepairAttempt(previous, result, validationFailure);
  const taskLoop = updateTaskLoop(previous, result, toolName, step);

  return {
    step,
    // phase 由“刚执行完的结果”反推，而不是由 planner 口头声明，避免状态漂移。
    phase: inferNextPhase(previous.phase ?? "investigate", result, validationFailure, repairAttempt),
    lastActionKind: result.action.kind,
    ...(toolName ? { lastToolName: toolName } : {}),
    lastObservation: {
      category: observationCategory(result),
      summary: observationSummary(result),
    },
    ...(taskLoop ? { taskLoop } : {}),
    ...(validationFailure
      ? { validationFailure }
      : result.metadata?.toolName === "run_validation"
        ? {}
        : previous.validationFailure
          ? { validationFailure: previous.validationFailure }
          : {}),
    ...(repairAttempt ? { repairAttempt } : {}),
    ...(isRetryableToolError
      ? {
          retryableToolErrors: {
            toolName,
            count: previous.retryableToolErrors?.toolName === toolName
              ? previous.retryableToolErrors.count + 1
              : 1,
          },
        }
      : {}),
  };
}

function inferNextPhase(
  previousPhase: PlannerPhase,
  result: ActionResult,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  repairAttempt: WorkingMemorySnapshot["repairAttempt"],
): PlannerPhase {
  // finish/fail/respond 都意味着当前回合已经可以进入对外总结阶段。
  if (result.action.kind === "finish" || result.action.kind === "fail" || result.action.kind === "respond") {
    return "summarize";
  }

  if (result.action.kind !== "tool_call") {
    return previousPhase;
  }

  const toolName = result.metadata?.toolName ?? result.action.toolName;
  if (toolName === "run_validation") {
    // validation 成功则总结；失败但有 suspectFile 则进入 edit / exhausted investigate。
    if (validationFailure?.suspectFile) return repairAttempt?.exhausted ? "investigate" : "edit";
    if (validationFailure) return "investigate";
    return result.ok ? "summarize" : "validate";
  }

  if (toolName === "completion_check") {
    const output = result.output as { status?: unknown } | null;
    if (output?.status === "needs_repair") {
      return validationFailure?.suspectFile ? "edit" : "investigate";
    }
    return "summarize";
  }

  if (result.metadata?.workspaceMutation === true) {
    return "validate";
  }

  if (
    toolName === "search_workspace"
    || toolName === "list_directory"
    || toolName === "inspect_project"
    || toolName === "code_map"
    || toolName === "dependency_graph"
    || toolName === "symbol_search"
  ) {
    return "investigate";
  }

  if (toolName === "read_text_file" && repairAttempt?.exhausted === true) {
    return "investigate";
  }

  if (result.ok && result.metadata?.category === "tool_observation") {
    return "summarize";
  }

  return previousPhase;
}

function updateRepairAttempt(
  previous: WorkingMemorySnapshot,
  result: ActionResult,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
): WorkingMemorySnapshot["repairAttempt"] | undefined {
  const toolName = result.metadata?.toolName ?? result.action.toolName;

  if (toolName === "run_validation") {
    // repairAttempt 以 suspectFile 为主键累计，避免把不同故障混成一条修复历史。
    if (!validationFailure?.suspectFile) return undefined;

    const previousForSameSuspect = previous.repairAttempt?.suspectFile === validationFailure.suspectFile
      ? previous.repairAttempt
      : undefined;
    const validationFailureCount = (previousForSameSuspect?.validationFailureCount ?? 0) + 1;
    const editAttemptCount = previousForSameSuspect?.editAttemptCount ?? 0;

    return {
      suspectFile: validationFailure.suspectFile,
      validationFailureCount,
      editAttemptCount,
      exhausted: validationFailureCount >= MAX_REPAIR_VALIDATION_FAILURES_PER_SUSPECT,
      ...(previousForSameSuspect?.lastStrategy ? { lastStrategy: previousForSameSuspect.lastStrategy } : {}),
      ...(previousForSameSuspect?.lastPatchSignature ? { lastPatchSignature: previousForSameSuspect.lastPatchSignature } : {}),
      ...(previousForSameSuspect?.triedStrategies ? { triedStrategies: previousForSameSuspect.triedStrategies } : {}),
      ...(previousForSameSuspect?.triedSuspectPaths ? { triedSuspectPaths: previousForSameSuspect.triedSuspectPaths } : {}),
      ...(previousForSameSuspect?.triedStrategyPaths ? { triedStrategyPaths: previousForSameSuspect.triedStrategyPaths } : {}),
      ...(previousForSameSuspect?.exhaustedSearchQuery ? { exhaustedSearchQuery: previousForSameSuspect.exhaustedSearchQuery } : {}),
      ...(previousForSameSuspect?.exhaustedSearchCandidatePaths ? { exhaustedSearchCandidatePaths: previousForSameSuspect.exhaustedSearchCandidatePaths } : {}),
      ...(previousForSameSuspect?.exhaustedReadCandidatePaths ? { exhaustedReadCandidatePaths: previousForSameSuspect.exhaustedReadCandidatePaths } : {}),
    };
  }

  if (toolName === "search_workspace") {
    // exhausted 后的 search 不是普通搜索，而是在为“下一批候选 suspect”留痕。
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!currentSuspect || previous.repairAttempt?.exhausted !== true) return previous.repairAttempt;
    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;
    if (!previousForSameSuspect) return previous.repairAttempt;

    const toolInput = result.action.toolInput as { query?: unknown } | null;
    const query = typeof toolInput?.query === "string" ? toolInput.query : undefined;
    const searchCandidatePaths = inferSearchResultPaths(result);

    return {
      ...previousForSameSuspect,
      ...(query ? { exhaustedSearchQuery: query } : {}),
      ...(searchCandidatePaths.length > 0 ? { exhaustedSearchCandidatePaths: searchCandidatePaths.slice(0, MAX_REPAIR_ATTEMPT_HISTORY) } : {}),
    };
  }

  if (toolName === "read_text_file" && previous.repairAttempt?.exhausted === true) {
    // exhausted 阶段读过哪些候选路径也要记住，避免反复读同一批文件。
    const readPath = inferReadResultPath(result);
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!readPath || !currentSuspect) return previous.repairAttempt;
    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;
    if (!previousForSameSuspect) return previous.repairAttempt;

    return {
      ...previousForSameSuspect,
      exhaustedReadCandidatePaths: compactAppend(previousForSameSuspect.exhaustedReadCandidatePaths, readPath),
    };
  }

  const mutationPath = inferWorkspaceMutationPath(result);
  if (mutationPath) {
    // 只有改到了 suspect 或其候选文件，才把这次写操作记入 repairAttempt。
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!currentSuspect) return undefined;
    if (!isRepairSuspectPath(previous.validationFailure, mutationPath)
      && !previous.repairAttempt?.exhaustedSearchCandidatePaths?.includes(mutationPath)) return undefined;

    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;

    return {
      suspectFile: currentSuspect,
      validationFailureCount: previousForSameSuspect?.validationFailureCount ?? 0,
      editAttemptCount: (previousForSameSuspect?.editAttemptCount ?? 0) + 1,
      exhausted: previousForSameSuspect?.exhausted ?? false,
      ...(previousForSameSuspect?.lastStrategy ? { lastStrategy: previousForSameSuspect.lastStrategy } : {}),
      ...(previousForSameSuspect?.lastPatchSignature ? { lastPatchSignature: previousForSameSuspect.lastPatchSignature } : {}),
      ...(previousForSameSuspect?.triedStrategies ? { triedStrategies: previousForSameSuspect.triedStrategies } : {}),
      ...(previousForSameSuspect?.triedSuspectPaths ? { triedSuspectPaths: previousForSameSuspect.triedSuspectPaths } : {}),
      ...(previousForSameSuspect?.triedStrategyPaths ? { triedStrategyPaths: previousForSameSuspect.triedStrategyPaths } : {}),
      ...(previousForSameSuspect?.exhaustedSearchQuery ? { exhaustedSearchQuery: previousForSameSuspect.exhaustedSearchQuery } : {}),
      ...(previousForSameSuspect?.exhaustedSearchCandidatePaths ? { exhaustedSearchCandidatePaths: previousForSameSuspect.exhaustedSearchCandidatePaths } : {}),
      ...(previousForSameSuspect?.exhaustedReadCandidatePaths ? { exhaustedReadCandidatePaths: previousForSameSuspect.exhaustedReadCandidatePaths } : {}),
      ...inferRepairPatchAttempt(result, mutationPath, previous.validationFailure, previousForSameSuspect),
    };
  }

  return previous.repairAttempt;
}

function inferRepairPatchAttempt(
  result: ActionResult,
  mutationPath: string,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  previousRepairAttempt: WorkingMemorySnapshot["repairAttempt"],
): Pick<NonNullable<WorkingMemorySnapshot["repairAttempt"]>, "lastStrategy" | "lastPatchSignature" | "triedStrategies" | "triedSuspectPaths" | "triedStrategyPaths"> {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  const toolInput = result.action.toolInput as Record<string, unknown> | null;
  const lastStrategy = describeRepairStrategy(validationFailure, toolName);

  if (toolName === "patch_text_file") {
    const oldString = typeof toolInput?.oldString === "string" ? toolInput.oldString : undefined;
    const newString = typeof toolInput?.newString === "string" ? toolInput.newString : undefined;
    if (oldString && newString) {
      const lastPatchSignature = createPatchSignature(mutationPath, oldString, newString);
      return {
        lastStrategy,
        lastPatchSignature,
        ...inferCompactAttemptHistory(previousRepairAttempt, lastStrategy, mutationPath),
      };
    }
  }

  if (toolName === "write_text_file") {
    const content = typeof toolInput?.content === "string" ? toolInput.content : undefined;
    if (typeof content === "string") {
      const lastPatchSignature = createWriteSignature(mutationPath, content);
      return {
        lastStrategy,
        lastPatchSignature,
        ...inferCompactAttemptHistory(previousRepairAttempt, lastStrategy, mutationPath),
      };
    }
  }

  return {};
}

function inferCompactAttemptHistory(
  previousRepairAttempt: WorkingMemorySnapshot["repairAttempt"],
  lastStrategy: string,
  mutationPath: string,
): Pick<NonNullable<WorkingMemorySnapshot["repairAttempt"]>, "triedStrategies" | "triedSuspectPaths" | "triedStrategyPaths"> {
  if (previousRepairAttempt?.exhausted !== true
    && !previousRepairAttempt?.triedStrategies
    && !previousRepairAttempt?.triedSuspectPaths
    && !previousRepairAttempt?.triedStrategyPaths) {
    return {};
  }

  return {
    triedStrategies: compactAppend(previousRepairAttempt?.triedStrategies, lastStrategy),
    triedSuspectPaths: compactAppend(previousRepairAttempt?.triedSuspectPaths, mutationPath),
    triedStrategyPaths: compactAppend(previousRepairAttempt?.triedStrategyPaths, createStrategyPathKey(lastStrategy, mutationPath)),
  };
}

function isRepairSuspectPath(
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  path: string,
): boolean {
  return inferRepairSuspectPaths(validationFailure).includes(path);
}

function inferRepairSuspectPaths(validationFailure: WorkingMemorySnapshot["validationFailure"]): string[] {
  const paths: string[] = [];
  if (validationFailure?.suspectFile) paths.push(validationFailure.suspectFile);
  if (validationFailure?.suspectImportPath) {
    paths.push(resolveRelatedImportPath(validationFailure.suspectFile, validationFailure.suspectImportPath));
  }
  return uniqueCompact(paths);
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

function compactAppend(values: string[] | undefined, value: string): string[] {
  return uniqueCompact([...(values ?? []), value]).slice(-MAX_REPAIR_ATTEMPT_HISTORY);
}

function inferReadResultPath(result: ActionResult): string | null {
  if (result.action.kind !== "tool_call" || result.action.toolName !== "read_text_file" || result.ok !== true) return null;
  const output = result.output as { path?: unknown } | null;
  return typeof output?.path === "string" && output.path.length > 0 ? output.path : null;
}

function inferSearchResultPaths(result: ActionResult): string[] {
  if (result.action.kind !== "tool_call" || result.action.toolName !== "search_workspace" || result.ok !== true) return [];
  const output = result.output as { results?: Array<{ file?: unknown }> } | null;
  const paths = Array.isArray(output?.results)
    ? output.results.map((item) => item.file).filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  return uniqueCompact(paths);
}

function uniqueCompact(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function describeRepairStrategy(
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  fallback: string | undefined,
): string {
  if (validationFailure?.suspectErrorCode === "TS2322") return "synthesized TS2322 number-literal fix";
  if (validationFailure?.suspectExportName && validationFailure.suspectImportStyle) return "synthesized import/export style fix";
  if (validationFailure?.assertExpected && validationFailure.assertActual) return "synthesized assertion expected-value fix";
  return fallback ?? "workspace mutation";
}

function createPatchSignature(path: string, oldString: string, newString: string): string {
  return JSON.stringify({ tool: "patch_text_file", path, oldString, newString });
}

function createWriteSignature(path: string, content: string): string {
  return JSON.stringify({ tool: "write_text_file", path, content });
}

function inferWorkspaceMutationPath(result: ActionResult): string | null {
  if (result.action.kind !== "tool_call") return null;
  if (result.ok !== true || result.metadata?.workspaceMutation !== true) return null;

  const toolInput = result.action.toolInput as { path?: unknown } | null;
  if (typeof toolInput?.path === "string" && toolInput.path.length > 0) return toolInput.path;

  const output = result.output as { path?: unknown } | null;
  return typeof output?.path === "string" && output.path.length > 0 ? output.path : null;
}

function inferValidationFailure(result: ActionResult): WorkingMemorySnapshot["validationFailure"] | undefined {
  if (result.metadata?.toolName !== "run_validation" || result.ok !== true) return undefined;
  if (!result.output || typeof result.output !== "object") return undefined;

  const output = result.output as {
    ok?: unknown;
    mode?: unknown;
    summary?: unknown;
    commands?: Array<{ name?: unknown; ok?: unknown; stdout?: unknown; stderr?: unknown }>;
  };

  if (output.ok !== false) return undefined;

  const mode = typeof output.mode === "string" ? output.mode as ValidationModeHint : "all";
  const summary = typeof output.summary === "string" ? output.summary : "Validation failed.";
  const failingCommands = Array.isArray(output.commands)
    ? output.commands
      .filter((command) => command && command.ok === false && typeof command.name === "string")
      .map((command) => command.name as string)
    : [];
  const rankedFailure = rankValidationFailure(mode, output.commands);
  const stdoutSnippet = rankedFailure?.stdoutSnippet;
  const stderrSnippet = rankedFailure?.stderrSnippet;
  const suspectLocation = rankedFailure?.suspectLocation;

  return {
    mode,
    failingCommands,
    summary,
    ...(stdoutSnippet ? { stdoutSnippet } : {}),
    ...(stderrSnippet ? { stderrSnippet } : {}),
    ...(suspectLocation?.file ? { suspectFile: suspectLocation.file } : {}),
    ...(typeof suspectLocation?.line === "number" ? { suspectLine: suspectLocation.line } : {}),
    ...(typeof suspectLocation?.column === "number" ? { suspectColumn: suspectLocation.column } : {}),
    ...(suspectLocation?.errorCode ? { suspectErrorCode: suspectLocation.errorCode } : {}),
    ...(suspectLocation?.importPath ? { suspectImportPath: suspectLocation.importPath } : {}),
    ...(suspectLocation?.importStyle ? { suspectImportStyle: suspectLocation.importStyle } : {}),
    ...(suspectLocation?.exportName ? { suspectExportName: suspectLocation.exportName } : {}),
    ...(suspectLocation?.failingTestName ? { failingTestName: suspectLocation.failingTestName } : {}),
    ...(suspectLocation?.assertExpected ? { assertExpected: suspectLocation.assertExpected } : {}),
    ...(suspectLocation?.assertActual ? { assertActual: suspectLocation.assertActual } : {}),
    ...(suspectLocation?.assertDiffSummary ? { assertDiffSummary: suspectLocation.assertDiffSummary } : {}),
  };
}

function rankValidationFailure(
  mode: ValidationModeHint,
  commands: Array<{ name?: unknown; ok?: unknown; stdout?: unknown; stderr?: unknown }> | undefined,
): {
  stdoutSnippet?: string;
  stderrSnippet?: string;
  suspectLocation?: ReturnType<typeof inferSuspectLocation>;
} | undefined {
  const failingCommands = Array.isArray(commands)
    ? commands.filter((command) => command && command.ok === false)
    : [];

  let best: {
    score: number;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    suspectLocation?: ReturnType<typeof inferSuspectLocation>;
  } | undefined;

  for (const command of failingCommands) {
    const stdoutSnippet = typeof command.stdout === "string" && command.stdout.length > 0
      ? command.stdout
      : undefined;
    const stderrSnippet = typeof command.stderr === "string" && command.stderr.length > 0
      ? command.stderr
      : undefined;
    const suspectLocation = inferSuspectLocation({
      mode,
      commandName: typeof command.name === "string" ? command.name : undefined,
      text: stderrSnippet ?? stdoutSnippet ?? "",
      fallbackText: stdoutSnippet ?? stderrSnippet ?? "",
    });
    const score = scoreSuspectLocation(suspectLocation) + (stderrSnippet ? 1 : 0) + (stdoutSnippet ? 1 : 0);

    if (!best || score > best.score) {
      best = { score, stdoutSnippet, stderrSnippet, suspectLocation };
    }
  }

  return best;
}

function scoreSuspectLocation(suspectLocation: ReturnType<typeof inferSuspectLocation>): number {
  if (!suspectLocation) return 0;

  let score = 0;
  if (suspectLocation.file) {
    score += 3;
    if (/node_modules\//.test(suspectLocation.file)) {
      score -= 2;
    }
    if (/\.test\.|tests?\//.test(suspectLocation.file)) {
      score -= 1;
    } else {
      score += 2;
    }
  }
  if (typeof suspectLocation.line === "number") score += 2;
  if (typeof suspectLocation.column === "number") score += 1;
  if (suspectLocation.errorCode) score += 1;
  if (suspectLocation.importPath) score += 7;
  if (suspectLocation.importStyle) score += 3;
  if (suspectLocation.exportName) score += 4;
  if (suspectLocation.failingTestName) score += 1;
  if (suspectLocation.assertExpected) score += 2;
  if (suspectLocation.assertActual) score += 2;
  if (suspectLocation.assertDiffSummary) score += 2;
  return score;
}

function inferSuspectLocation(input: {
  mode: ValidationModeHint;
  commandName?: string;
  text: string;
  fallbackText?: string;
}): {
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  importPath?: string;
  importStyle?: string;
  exportName?: string;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {

  const primaryText = input.text;
  const secondaryText = input.fallbackText ?? "";
  const parserHint = input.commandName ?? input.mode;

  const specialized = inferSpecializedSuspectLocation(parserHint, primaryText, secondaryText);
  if (specialized) return specialized;

  return inferGenericSuspectLocation(primaryText || secondaryText);
}

function inferSpecializedSuspectLocation(
  parserHint: string,
  primaryText: string,
  secondaryText: string,
): {
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  importPath?: string;
  importStyle?: string;
  exportName?: string;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {
  if (parserHint === "typecheck") {
    return inferTypecheckSuspectLocation(primaryText || secondaryText);
  }

  if (parserHint === "test") {
    return inferTestSuspectLocation(primaryText || secondaryText);
  }

  if (parserHint === "build") {
    return inferBuildSuspectLocation(primaryText || secondaryText);
  }

  return undefined;
}

function inferTypecheckSuspectLocation(text: string): { file?: string; line?: number; column?: number; errorCode?: string } | undefined {
  if (!text) return undefined;

  const fileLineMatch = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/) 
    ?? text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\)/);
  const errorCodeMatch = text.match(/\b([A-Z]{2,}\d{3,})\b/);

  if (!fileLineMatch && !errorCodeMatch) return undefined;

  return {
    ...(fileLineMatch?.[1] ? { file: fileLineMatch[1] } : {}),
    ...(fileLineMatch?.[2] ? { line: Number(fileLineMatch[2]) } : {}),
    ...(fileLineMatch?.[3] ? { column: Number(fileLineMatch[3]) } : {}),
    ...(errorCodeMatch?.[1] ? { errorCode: errorCodeMatch[1] } : {}),
  };
}

function inferTestSuspectLocation(text: string): {
  file?: string;
  line?: number;
  column?: number;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {
  if (!text) return undefined;

  const failingTestMatch = text.match(/^FAILED\s+([^\s]+)\s+-/m)
    ?? text.match(/^\s*FAIL\s+(.+)$/m);
  const fileLineMatches = Array.from(text.matchAll(/([A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|jsx)):(\d+)(?::(\d+))?/g));
  const preferredFileLineMatch = choosePreferredSourceFrame(fileLineMatches);
  const expectedValue = extractAssertionBlock(text, "Expected", ["Received", "Actual"]);
  const actualValue = extractAssertionBlock(text, "Received", []) ?? extractAssertionBlock(text, "Actual", []);
  const assertDiffSummary = expectedValue && actualValue
    ? summarizeAssertionDiff(expectedValue, actualValue)
    : summarizeSnapshotStyleDiff(text);

  if (!failingTestMatch && !preferredFileLineMatch && !expectedValue && !actualValue) return undefined;

  return {
    ...(failingTestMatch?.[1] ? { failingTestName: failingTestMatch[1] } : {}),
    ...(preferredFileLineMatch?.[1] ? { file: preferredFileLineMatch[1] } : {}),
    ...(preferredFileLineMatch?.[2] ? { line: Number(preferredFileLineMatch[2]) } : {}),
    ...(preferredFileLineMatch?.[3] ? { column: Number(preferredFileLineMatch[3]) } : {}),
    ...(expectedValue ? { assertExpected: expectedValue } : {}),
    ...(actualValue ? { assertActual: actualValue } : {}),
    ...(assertDiffSummary ? { assertDiffSummary } : {}),
  };
}

function choosePreferredSourceFrame(matches: RegExpMatchArray[]): RegExpMatchArray | undefined {
  const score = (filePath: string): number => {
    let value = 0;
    if (!/node_modules\//.test(filePath)) value += 5;
    if (!/\.test\.|tests?\//.test(filePath)) value += 4;
    if (/^src\//.test(filePath)) value += 3;
    return value;
  };

  return matches
    .map((match) => ({ match, score: score(match[1] ?? "") }))
    .sort((a, b) => b.score - a.score)[0]?.match;
}

function extractAssertionBlock(text: string, label: "Expected" | "Received" | "Actual", stopLabels: Array<"Expected" | "Received" | "Actual">): string | undefined {
  const lines = text.split("\n");
  const startIndex = lines.findIndex((line) => line.startsWith(`${label}:`));
  if (startIndex === -1) return undefined;

  const firstRawLine = lines[startIndex];
  if (typeof firstRawLine !== "string") return undefined;
  const firstLine = firstRawLine.slice(`${label}:`.length).trimStart();
  const collected = [firstLine];

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    if (stopLabels.some((stopLabel) => line.startsWith(`${stopLabel}:`))) break;
    if (/^\s*[❯›>]/.test(line)) break;
    if (/^\s*at\s+/.test(line)) break;
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function summarizeAssertionDiff(expected: string, actual: string): string {
  const structured = summarizeStructuredAssertionDiff(expected, actual);
  if (structured) return structured;

  const compact = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 120);
  return `Expected ${compact(expected)} but received ${compact(actual)}`;
}

function summarizeStructuredAssertionDiff(expected: string, actual: string): string | undefined {
  const parsedExpected = tryParseStructuredAssertionValue(expected);
  const parsedActual = tryParseStructuredAssertionValue(actual);
  if (!parsedExpected || !parsedActual) return undefined;

  if (Array.isArray(parsedExpected) && Array.isArray(parsedActual)) {
    return summarizeArrayAssertionDiff(parsedExpected, parsedActual);
  }

  if (isPlainObject(parsedExpected) && isPlainObject(parsedActual)) {
    return summarizeObjectAssertionDiff(parsedExpected, parsedActual);
  }

  return undefined;
}

function summarizeObjectAssertionDiff(expected: Record<string, unknown>, actual: Record<string, unknown>): string | undefined {
  const pathDiffs = collectAssertionPathDiffs(expected, actual);
  const missingPaths = collectMissingAssertionPaths(expected, actual);
  const unexpectedPaths = collectUnexpectedAssertionPaths(expected, actual);

  const parts: string[] = [];
  if (pathDiffs.length > 0) {
    parts.push(`Mismatched paths: ${pathDiffs.map((diff) => `${diff.path} (expected ${formatAssertionValue(diff.expected)}, received ${formatAssertionValue(diff.actual)})`).join(", ")}`);
  }
  if (missingPaths.length > 0) {
    parts.push(`Missing keys in actual: ${missingPaths.join(", ")}`);
  }
  if (unexpectedPaths.length > 0) {
    parts.push(`Unexpected keys in actual: ${unexpectedPaths.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function summarizeArrayAssertionDiff(expected: unknown[], actual: unknown[]): string | undefined {
  const mismatchedEntries: string[] = [];
  const maxLength = Math.max(expected.length, actual.length);

  for (let index = 0; index < maxLength; index++) {
    const hasExpected = index < expected.length;
    const hasActual = index < actual.length;
    if (hasExpected && hasActual) {
      if (!deepEqualAssertionValue(expected[index], actual[index])) {
        mismatchedEntries.push(`[${index}] expected ${formatAssertionValue(expected[index])}, received ${formatAssertionValue(actual[index])}`);
      }
      continue;
    }
  }

  const missingEntries = expected
    .slice(actual.length)
    .map((value, offset) => `[${actual.length + offset}]=${formatAssertionValue(value)}`);
  const unexpectedEntries = actual
    .slice(expected.length)
    .map((value, offset) => `[${expected.length + offset}]=${formatAssertionValue(value)}`);

  const parts: string[] = [];
  if (mismatchedEntries.length > 0) {
    parts.push(`Array diffs: ${mismatchedEntries.join(", ")}`);
  }
  if (missingEntries.length > 0) {
    parts.push(`Missing items in actual: ${missingEntries.join(", ")}`);
  }
  if (unexpectedEntries.length > 0) {
    parts.push(`Unexpected items in actual: ${unexpectedEntries.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function summarizeSnapshotStyleDiff(text: string): string | undefined {
  const lines = text.split("\n");
  const removedLines = lines.filter((line) => /^-\s+/.test(line));
  const addedLines = lines.filter((line) => /^\+\s+/.test(line));
  if (removedLines.length === 0 || addedLines.length === 0) return undefined;

  const pairCount = Math.min(removedLines.length, addedLines.length);
  const pairs: string[] = [];
  for (let index = 0; index < pairCount; index++) {
    const removed = removedLines[index]?.replace(/^-\s*/, "").trim();
    const added = addedLines[index]?.replace(/^\+\s*/, "").trim();
    if (!removed || !added) continue;

    const removedEntry = parseSnapshotDiffEntry(removed);
    const addedEntry = parseSnapshotDiffEntry(added);
    if (!removedEntry || !addedEntry) continue;
    if (removedEntry.key !== addedEntry.key) continue;

    pairs.push(`${removedEntry.key} (removed ${removedEntry.value}, added ${addedEntry.value})`);
  }

  return pairs.length > 0 ? `Snapshot diffs: ${pairs.join(", ")}` : undefined;
}

function parseSnapshotDiffEntry(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^"?([^":]+)"?\s*:\s*(.+?)(,)?$/);
  if (!match) return undefined;
  return {
    key: match[1]?.trim() ?? "",
    value: (match[2] ?? "").trim(),
  };
}

function collectAssertionPathDiffs(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): Array<{ path: string; expected: unknown; actual: unknown }> {
  const diffs: Array<{ path: string; expected: unknown; actual: unknown }> = [];

  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) continue;

    const nextPath = prefix ? `${prefix}.${key}` : key;
    const expectedValue = expected[key];
    const actualValue = actual[key];

    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      diffs.push(...collectAssertionPathDiffs(expectedValue, actualValue, nextPath));
      continue;
    }

    if (!deepEqualAssertionValue(expectedValue, actualValue)) {
      diffs.push({ path: nextPath, expected: expectedValue, actual: actualValue });
    }
  }

  return diffs;
}

function collectMissingAssertionPaths(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];

  for (const key of Object.keys(expected)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      paths.push(nextPath);
      continue;
    }

    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      paths.push(...collectMissingAssertionPaths(expectedValue, actualValue, nextPath));
    }
  }

  return paths;
}

function collectUnexpectedAssertionPaths(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];

  for (const key of Object.keys(actual)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      paths.push(nextPath);
      continue;
    }

    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      paths.push(...collectUnexpectedAssertionPaths(expectedValue, actualValue, nextPath));
    }
  }

  return paths;
}

function tryParseStructuredAssertionValue(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualAssertionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatAssertionValue(value: unknown): string {
  return JSON.stringify(value);
}

function inferBuildSuspectLocation(text: string): { file?: string; importPath?: string; importStyle?: string; exportName?: string } | undefined {
  if (!text) return undefined;

  const resolveMatch = text.match(/Could not resolve\s+"([^"]+)"\s+from\s+"([^"]+)"/);
  if (resolveMatch) {
    return {
      importPath: resolveMatch[1],
      file: resolveMatch[2],
    };
  }

  const moduleNotFoundMatch = text.match(/Can't resolve\s+'([^']+)'/);
  if (moduleNotFoundMatch) {
    return {
      importPath: moduleNotFoundMatch[1],
    };
  }

  const exportMismatchMatch = text.match(/module\s+'([^']+)'\s+does not provide an export named\s+'([^']+)'/i)
    ?? text.match(/module\s+"([^"]+)"\s+does not provide an export named\s+"([^"]+)"/i)
    ?? text.match(/requested module\s+'([^']+)'\s+does not provide an export named\s+'([^']+)'/i)
    ?? text.match(/requested module\s+"([^"]+)"\s+does not provide an export named\s+"([^"]+)"/i);
  if (exportMismatchMatch) {
    return {
      file: exportMismatchMatch[1],
      exportName: exportMismatchMatch[2],
    };
  }

  const webpackExportMismatchMatch = text.match(/export\s+'([^']+)'\s+\(imported as\s+'([^']+)'\)\s+was not found in\s+'([^']+)'/i)
    ?? text.match(/export\s+"([^"]+)"\s+\(imported as\s+"([^"]+)"\)\s+was not found in\s+"([^"]+)"/i);
  if (webpackExportMismatchMatch) {
    const requestedExport = webpackExportMismatchMatch[1] || webpackExportMismatchMatch[2];
    const importStyle = requestedExport === "default" ? "default" : "named";
    return {
      file: webpackExportMismatchMatch[3],
      exportName: requestedExport,
      importStyle,
    };
  }

  const esbuildExportMismatchMatch = text.match(/No matching export in\s+"([^"]+)"\s+for import\s+"([^"]+)"/i)
    ?? text.match(/No matching export in\s+'([^']+)'\s+for import\s+'([^']+)'/i);
  if (esbuildExportMismatchMatch) {
    const requestedExport = esbuildExportMismatchMatch[2];
    const importStyle = requestedExport === "default" ? "default" : "named";
    return {
      file: esbuildExportMismatchMatch[1],
      exportName: requestedExport,
      importStyle,
    };
  }

  const missingDefaultExportMatch = text.match(/Attempted import error:\s+'([^']+)'\s+does not contain a default export/i);
  if (missingDefaultExportMatch) {
    return {
      file: missingDefaultExportMatch[1],
      exportName: "default",
      importStyle: "default",
    };
  }

  const missingNamedExportMatch = text.match(/Attempted import error:\s+'([^']+)'\s+is not exported from\s+'([^']+)'/i);
  if (missingNamedExportMatch) {
    return {
      file: missingNamedExportMatch[2],
      exportName: missingNamedExportMatch[1],
      importStyle: "named",
    };
  }

  return undefined;
}

function inferGenericSuspectLocation(text: string): { file?: string; line?: number; column?: number; errorCode?: string } | undefined {
  if (!text) return undefined;

  const fileLineMatch = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/);
  const errorCodeMatch = text.match(/\b([A-Z]{2,}\d{3,})\b/);

  if (!fileLineMatch && !errorCodeMatch) return undefined;

  return {
    ...(fileLineMatch?.[1] ? { file: fileLineMatch[1] } : {}),
    ...(fileLineMatch?.[2] ? { line: Number(fileLineMatch[2]) } : {}),
    ...(fileLineMatch?.[3] ? { column: Number(fileLineMatch[3]) } : {}),
    ...(errorCodeMatch?.[1] ? { errorCode: errorCodeMatch[1] } : {}),
  };
}

export function applyActionResultToWorkingMemory(
  previous: WorkingMemorySnapshot,
  step: number,
  result: ActionResult,
): WorkingMemorySnapshot {
  return updateWorkingMemory(previous, step, result);
}

function shouldStopForUsageBudget(
  total: RunTokenUsage,
  latest: LlmTokenUsage,
  budget: LoopContext["usageBudget"] | undefined,
): string | null {
  const maxModelRequests = budget?.maxModelRequests ?? DEFAULT_USAGE_BUDGET.maxModelRequests;
  const maxTotalTokens = budget?.maxTotalTokens ?? DEFAULT_USAGE_BUDGET.maxTotalTokens;
  const maxPromptEstimateTokens = budget?.maxPromptEstimateTokens ?? DEFAULT_USAGE_BUDGET.maxPromptEstimateTokens;

  if (maxModelRequests > 0 && total.requestCount >= maxModelRequests) {
    return `已达到本轮 ${maxModelRequests} 次模型调用预算，先暂停以避免继续消耗余额。最近一次模型：${latest.provider}/${latest.model}。`;
  }
  if (maxTotalTokens > 0 && total.totalTokens >= maxTotalTokens) {
    return `已达到本轮约 ${total.totalTokens} token 用量预算，先暂停以避免继续消耗余额。`;
  }
  if (maxPromptEstimateTokens > 0 && total.promptEstimateTokens >= maxPromptEstimateTokens) {
    return `已达到本轮约 ${total.promptEstimateTokens} token 的上下文估算预算，先暂停以避免长上下文循环。`;
  }
  return null;
}

export async function runLoop(
  input: BrainInput,
  deps: LoopDeps,
  maxSteps = 10,
  context?: LoopContext,
): Promise<LoopState> {
  const resetForNewTask = shouldStartFreshTaskLoop(input);
  const seededHistory = resetForNewTask ? [] : [...input.history];
  const workingMemory = createInitialWorkingMemory(
    { ...input, history: seededHistory },
    resetForNewTask,
  );
  const seededSteps = workingMemory.step ?? seededHistory.length;
  const state: LoopState = {
    steps: seededSteps,
    history: seededHistory,
    workingMemory,
    lastDecision: null,
    lastResult: seededHistory.length > 0 ? seededHistory[seededHistory.length - 1] ?? null : null,
    stopReason: null,
    stopSummary: null,
    usage: context?.initialUsage ?? emptyRunTokenUsage(),
  };
  input = { ...input, history: state.history, workingMemory: state.workingMemory };
  await emitTaskLoopProgress(context, state, "initialized", "Task loop initialized.");

  for (let i = seededSteps; i < maxSteps; i++) {
    throwIfAborted(context?.signal);
    state.steps++;

    if (appendPendingSuccessfulValidationCompletionCheck(state, input.availableTools)) {
      input = { ...input, history: state.history, workingMemory: state.workingMemory };
      await emitTaskLoopProgress(context, state, "advanced", "Inserted completion check after successful validation.");
      continue;
    }

    const rawDecision = await deps.planner.decide(input, { signal: context?.signal });
    if (rawDecision.usage) {
      state.usage = addUsageToRunUsage(state.usage, rawDecision.usage);
      await context?.onUsage?.(rawDecision.usage, state.usage);
      const budgetStop = shouldStopForUsageBudget(state.usage, rawDecision.usage, context?.usageBudget);
      if (budgetStop) {
        state.lastDecision = rawDecision;
        state.stopReason = "usage_limit";
        state.stopSummary = budgetStop;
        break;
      }
    }
    const duplicateResolution = resolveDuplicateWorkspaceMutation(rawDecision, state.history, input.availableTools);
    if (duplicateResolution.kind === "observation") {
      state.lastDecision = duplicateResolution.decision;
      state.lastResult = duplicateResolution.result;
      state.history.push(duplicateResolution.result);
      state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, duplicateResolution.result);
      input = { ...input, history: state.history, workingMemory: state.workingMemory };
      await emitTaskLoopProgress(context, state, "advanced", "Converted duplicate workspace mutation into a completion check.");
      continue;
    }

    const taskLoopGatedDecision = resolvePrematureTaskLoopFinalAnswer(
      duplicateResolution.decision,
      input,
      state.lastResult,
    );
    const readyGatedDecision = resolveUnnecessaryToolAfterTaskLoopReady(
      taskLoopGatedDecision,
      input,
      state.lastResult,
    );
    const decision = resolveRepeatedReadOnlyNoProgress(
      readyGatedDecision,
      state.history,
      input.availableTools,
      latestUserMessage(input),
    );
    const approved = await deps.policy.check(decision);
    state.lastDecision = approved;

    throwIfAborted(context?.signal);
    const result = await deps.dispatcher.dispatch(approved, { signal: context?.signal });
    throwIfAborted(context?.signal);
    state.lastResult = result;
    state.history.push(result);
    state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, result);
    await emitTaskLoopProgress(context, state, "advanced", summarizeTaskLoopProgress(state, result));

    const action = await deps.evaluator.evaluate(approved, result, state.history);
    if (action.kind === "stop") {
      state.stopReason = action.reason;
      state.stopSummary = action.summary ?? null;
      await emitTaskLoopProgress(context, state, "finalized", state.stopSummary ?? `Run stopped with ${action.reason}.`);
      break;
    }

    input = { ...input, history: state.history, workingMemory: state.workingMemory };
  }

  if (appendPendingSuccessfulValidationCompletionCheck(state, input.availableTools)) {
    await emitTaskLoopProgress(context, state, "advanced", "Inserted final completion check after successful validation.");
  }
  finalizeDanglingCompletionCheck(state);
  if (state.stopSummary && state.lastResult?.metadata?.syntheticFinalFeedback === true) {
    await emitTaskLoopProgress(context, state, "finalized", state.stopSummary);
  }
  if (!state.stopReason && state.steps >= maxSteps) {
    state.stopReason = "step_limit";
    state.stopSummary = buildStepLimitStopSummary(state, maxSteps);
    await emitTaskLoopProgress(context, state, "checkpoint", state.stopSummary);
  }
  return state;
}

function buildStepLimitStopSummary(state: LoopState, maxSteps: number): string {
  const taskLoop = state.workingMemory.taskLoop;
  const currentTask = taskLoop?.tasks?.find((task) => task.id === taskLoop.currentTaskId)
    ?? taskLoop?.tasks?.find((task) => task.status === "active" || task.status === "blocked");
  const currentCriterion = currentTask?.criteria.find((criterion) => criterion.status === "pending" || criterion.status === "failed");
  const latestTool = state.lastResult?.metadata?.toolName ?? state.lastResult?.action.toolName;
  const latestEvidence = taskLoop?.evidenceLog?.[taskLoop.evidenceLog.length - 1];
  const parts = [
    `已到达本轮 ${maxSteps} 步安全预算，还没有形成最终反馈。`,
    currentTask?.title ? `当前正在：${currentTask.title}。` : null,
    currentCriterion?.description ? `待完成条件：${currentCriterion.description}` : null,
    latestTool ? `最近工具：${latestTool}。` : null,
    latestEvidence ? `最近证据：${latestEvidence.quality}/${latestEvidence.kind}${latestEvidence.target ? `，目标 ${latestEvidence.target}` : ""}。` : null,
    "为避免工具循环或长任务空转，运行已暂停；继续工作后会从当前检查点接着推进，不会从头开始。",
  ];
  return parts.filter(Boolean).join("");
}

async function emitTaskLoopProgress(
  context: LoopContext | undefined,
  state: LoopState,
  phase: "initialized" | "advanced" | "checkpoint" | "finalized",
  summary: string,
): Promise<void> {
  await context?.onTaskLoop?.(state.workingMemory, {
    step: state.steps,
    phase,
    summary,
    ...(state.lastResult ? { result: state.lastResult } : {}),
  });
}

function summarizeTaskLoopProgress(state: LoopState, result: ActionResult): string {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  const taskLoop = state.workingMemory.taskLoop;
  const currentTask = taskLoop?.tasks?.find((task) => task.id === taskLoop.currentTaskId);
  const currentCriterion = currentTask?.criteria.find((criterion) => criterion.status === "pending" || criterion.status === "failed");
  if (result.action.kind === "respond" || result.action.kind === "finish") {
    return "已形成最终反馈。";
  }
  if (result.action.kind === "fail") {
    return result.error ?? "Run failed.";
  }
  if (!toolName) return observationSummary(result);
  const summary = observationSummary(result).replace(/\s+/g, " ").trim();
  const latestEvidence = taskLoop?.evidenceLog?.[taskLoop.evidenceLog.length - 1];
  return [
    `已完成工具：${toolName}`,
    latestEvidence ? `证据：${latestEvidence.quality}/${latestEvidence.kind}` : null,
    latestEvidence?.target ? `目标：${latestEvidence.target}` : null,
    currentTask?.title ? `当前任务：${currentTask.title}` : null,
    currentCriterion?.description ? `待满足：${currentCriterion.description}` : null,
    summary,
  ].filter(Boolean).join("；").slice(0, 260);
}

function appendPendingSuccessfulValidationCompletionCheck(
  state: LoopState,
  availableTools: BrainInput["availableTools"],
): boolean {
  if (state.stopReason) return false;
  const completionCheck = resolveSuccessfulValidationCompletionCheck(state.history, availableTools);
  if (!completionCheck) return false;

  state.lastDecision = completionCheck.decision;
  state.lastResult = completionCheck.result;
  state.history.push(completionCheck.result);
  state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, completionCheck.result);
  return true;
}

function resolveSuccessfulValidationCompletionCheck(
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
): { decision: BrainDecision; result: ActionResult } | null {
  const latest = history[history.length - 1];
  if (!latest || latest.action.kind !== "tool_call" || latest.action.toolName !== "run_validation") return null;
  if (!latest.ok || validationDidFail(latest)) return null;
  if (!availableTools.some((tool) => tool.name === "completion_check" || tool.name === "run_validation")) return null;

  const mutation = findLatestSuccessfulWorkspaceMutationBefore(history, history.length - 1);
  if (!mutation) return null;

  const signature = toolActionSignature(mutation.result.action);
  if (signature ? hasCompletionCheckAfterMutation(history, mutation.index, signature) : hasAnyCompletionCheckAfterMutation(history, mutation.index)) {
    return null;
  }

  return buildCompletionCheckResult(
    {
      action: mutation.result.action,
      reasoning: "Successful validation after a workspace mutation requires a completion gate before final user feedback.",
    },
    mutation.result,
    latest,
    signature,
    {
      repeatedActionPrevented: false,
      reasoning: "Successful workspace mutation was validated; inserting a completion check so the planner must judge whether the task is done.",
      summary: "Completion check: mutation and validation are complete; produce final user feedback or choose a genuinely new next step.",
      instruction: "The mutation and validation are complete. Decide whether the user's requested outcome is satisfied, then respond with final user-facing feedback; do not repeat the same tool input.",
    },
  );
}

type DuplicateWorkspaceMutationResolution =
  | { kind: "decision"; decision: BrainDecision }
  | { kind: "observation"; decision: BrainDecision; result: ActionResult };

function resolvePrematureTaskLoopFinalAnswer(
  decision: BrainDecision,
  input: BrainInput,
  lastResult: ActionResult | null,
): BrainDecision {
  if (decision.action.kind !== "respond" && decision.action.kind !== "finish" && decision.action.kind !== "fail") {
    return decision;
  }

  const taskLoop = input.workingMemory?.taskLoop;
  const tasks = taskLoop?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return decision;

  const activeTask = tasks.find((task) => task.id === taskLoop?.currentTaskId)
    ?? tasks.find((task) => task.status === "active" || task.status === "blocked")
    ?? null;
  if (!activeTask || activeTask.id === "answer") return decision;
  if (!activeTask.criteria.some((criterion) => criterion.status === "pending" || criterion.status === "failed")) {
    return decision;
  }

  const judgment = judgeTaskCompletion(input, lastResult, latestUserMessage(input));
  if (judgment.status === "ready" || !judgment.recommendedToolName) return decision;
  if (!hasTool(input.availableTools, judgment.recommendedToolName)) return decision;

  return {
    action: {
      kind: "tool_call",
      toolName: judgment.recommendedToolName,
      toolInput: judgment.recommendedToolInput,
    },
    reasoning: [
      decision.reasoning,
      `Task-loop final-answer gate: ${judgment.reason}`,
    ].filter(Boolean).join(" "),
  };
}

function resolveUnnecessaryToolAfterTaskLoopReady(
  decision: BrainDecision,
  input: BrainInput,
  lastResult: ActionResult | null,
): BrainDecision {
  if (decision.action.kind !== "tool_call") return decision;
  if (!isTaskLoopReadyForFinalFeedback(input.workingMemory, input.history, lastResult)) return decision;
  if (!lastResult?.ok) return decision;

  const feedback = buildTaskLoopReadyFeedback(input, lastResult, decision.action.toolName ?? "tool");
  if (!feedback) return decision;

  return {
    action: { kind: "respond", content: feedback },
    reasoning: [
      decision.reasoning,
      "Task-loop final-answer gate: evidence checklist is ready, so returning final feedback instead of spending another tool call.",
    ].filter(Boolean).join(" "),
  };
}

function isTaskLoopReadyForFinalFeedback(
  workingMemory: WorkingMemorySnapshot | undefined,
  history: ActionResult[],
  lastResult: ActionResult | null,
): boolean {
  const taskLoop = workingMemory?.taskLoop;
  if (!taskLoop) return false;
  if (taskLoop.needsFinalAnswer === true) return true;
  const currentTask = taskLoop.tasks?.find((task) => task.id === taskLoop.currentTaskId);
  if (currentTask?.id !== "answer") return false;
  return hasFinalFeedbackEvidenceForTaskLoop(taskLoop.mode, history, lastResult);
}

function hasFinalFeedbackEvidenceForTaskLoop(
  mode: NonNullable<WorkingMemorySnapshot["taskLoop"]>["mode"],
  history: ActionResult[],
  lastResult: ActionResult | null,
): boolean {
  const recent = [...history.slice(-12), ...(lastResult ? [lastResult] : [])];
  if (mode === "chat") return true;
  if (mode === "web") {
    return recent.some((result) => {
      if (!result.ok || result.action.kind !== "tool_call") return false;
      const toolName = result.metadata?.toolName ?? result.action.toolName;
      return toolName === "web_fetch" && hasTaskLoopWebBodyEvidence(result.output);
    });
  }
  if (mode === "edit" || mode === "validation") {
    return recent.some((result) => {
      if (!result.ok || result.action.kind !== "tool_call") return false;
      const toolName = result.metadata?.toolName ?? result.action.toolName;
      return toolName === "completion_check" || toolName === "run_validation";
    });
  }
  return recent.some((result) => {
    if (!result.ok || result.action.kind !== "tool_call") return false;
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    return toolName === "read_text_file" || toolName === "completion_check";
  });
}

function buildTaskLoopReadyFeedback(
  input: BrainInput,
  lastResult: ActionResult,
  proposedToolName: string,
): string | null {
  const completionPayload = parseCompletionCheckPayload(lastResult);
  if (completionPayload) return buildCompletionCheckFeedback(completionPayload);

  const summary = summarizeReadOnlyObservation(lastResult, latestUserMessage(input));
  if (summary) return summary;

  const observation = observationSummary(lastResult).trim();
  if (!observation) return null;
  return [
    `当前任务循环已经满足最终反馈条件，因此没有继续调用 ${proposedToolName}。`,
    observation,
  ].join("\n\n");
}

function resolveRepeatedReadOnlyNoProgress(
  decision: BrainDecision,
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
  message: string,
): BrainDecision {
  if (decision.action.kind !== "tool_call" || !decision.action.toolName) return decision;
  if (!isRepeatProtectedReadOnlyAction(decision.action, availableTools)) return decision;

  const signature = toolActionSignature(decision.action);
  if (!signature) return decision;
  const priorSame = history
    .slice(-4)
    .some((result) => result.ok === true && toolActionSignature(result.action) === signature);
  if (!priorSame) return decision;

  const recovery = inferReadOnlyRecoveryDecision(history, availableTools, decision.action.toolName, message);
  if (!recovery) {
    const feedback = buildReadOnlyCompletionFeedback(history, message, decision.action.toolName);
    if (!feedback) return decision;
    return {
      action: { kind: "respond", content: feedback },
      reasoning: [
        decision.reasoning,
        `Repeated read-only tool call ${decision.action.toolName} would not add new evidence; summarizing collected evidence instead of looping.`,
      ].filter(Boolean).join(" "),
    };
  }

  return {
    ...recovery,
    reasoning: [
      decision.reasoning,
      `Repeated read-only tool call ${decision.action.toolName} would not add new evidence; switching to a higher-signal recovery action.`,
      recovery.reasoning,
    ].filter(Boolean).join(" "),
  };
}

function resolveDuplicateWorkspaceMutation(
  decision: BrainDecision,
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
): DuplicateWorkspaceMutationResolution {
  const duplicate = findDuplicateSuccessfulWorkspaceMutation(decision, history, availableTools);
  if (!duplicate) return { kind: "decision", decision };

  const hasValidationTool = availableTools.some((tool) => tool.name === "run_validation");
  const latestValidationAfterMutation = findLatestValidationAfterMutation(history, duplicate.index);

  if (hasValidationTool && !latestValidationAfterMutation) {
    return {
      kind: "decision",
      decision: {
      action: {
        kind: "tool_call",
        toolName: "run_validation",
        toolInput: { mode: duplicate.result.metadata?.validationMode ?? "all" },
      },
      reasoning: [
        decision.reasoning,
        "Duplicate workspace mutation already executed; validating instead of requesting the same approval again.",
      ].filter(Boolean).join(" "),
      },
    };
  }

  const signature = toolActionSignature(decision.action);
  if (signature && hasCompletionCheckAfterMutation(history, duplicate.index, signature)) {
    const feedback = buildCompletionGateFeedback(decision, duplicate.result, latestValidationAfterMutation);
    return {
      kind: "decision",
      decision: {
        action: latestValidationAfterMutation && validationDidFail(latestValidationAfterMutation)
          ? { kind: "fail", reason: feedback }
          : { kind: "respond", content: feedback },
        reasoning: [
          decision.reasoning,
          "Planner repeated the same workspace mutation after a completion check; returning the final completion judgment as a safety stop.",
        ].filter(Boolean).join(" "),
      },
    };
  }

  const completionCheck = buildCompletionCheckResult(decision, duplicate.result, latestValidationAfterMutation, signature);
  return {
    kind: "observation",
    decision: completionCheck.decision,
    result: completionCheck.result,
  };
}

function buildCompletionCheckResult(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
  duplicateSignature: string | null,
  options: {
    repeatedActionPrevented?: boolean;
    reasoning?: string;
    summary?: string;
    instruction?: string;
  } = {},
): { decision: BrainDecision; result: ActionResult } {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const validationFailed = latestValidation ? validationDidFail(latestValidation) : false;
  const validationSummary = latestValidation ? summarizeValidationResult(latestValidation) : null;
  const status = validationFailed ? "needs_repair" : "ready_for_final_feedback";
  const repeatedActionPrevented = options.repeatedActionPrevented ?? true;
  const output = {
    status,
    repeatedActionPrevented,
    duplicateSignature,
        action: {
          toolName,
          target,
          label: labelWorkspaceActionSafe(toolName),
        },
    validation: latestValidation
      ? {
          ok: !validationFailed,
          summary: validationSummary,
        }
      : null,
    instruction: validationFailed
      ? "The repeated mutation was blocked. Use the validation result and history to choose a different repair or explain the failure; do not repeat the same tool input."
      : options.instruction ?? "The mutation and validation are complete. Decide whether the user's task is satisfied, then respond with final user-facing feedback; do not repeat the same tool input.",
  };
  const checkDecision: BrainDecision = {
    action: {
      kind: "tool_call",
      toolName: "completion_check",
      toolInput: output,
    },
    reasoning: [
      decision.reasoning,
      options.reasoning ?? "Duplicate workspace mutation was converted into a completion check so the planner can make the final judgment.",
    ].filter(Boolean).join(" "),
  };

  return {
    decision: checkDecision,
    result: {
      action: checkDecision.action,
      ok: true,
      output,
      metadata: {
        category: "tool_observation",
        summary: validationFailed
          ? "Completion check: previous mutation exists, but validation failed; choose a different repair or report failure."
          : options.summary ?? "Completion check: previous mutation and validation are complete; produce final user feedback.",
        retryable: false,
        toolName: "completion_check",
      },
    },
  };
}

function hasCompletionCheckAfterMutation(
  history: ActionResult[],
  mutationIndex: number,
  duplicateSignature: string,
): boolean {
  for (let index = history.length - 1; index > mutationIndex; index--) {
    const result = history[index];
    if (result?.action.kind !== "tool_call" || result.action.toolName !== "completion_check") continue;
    const output = result.output as { duplicateSignature?: unknown } | null;
    if (output?.duplicateSignature === duplicateSignature) return true;
  }
  return false;
}

function hasAnyCompletionCheckAfterMutation(history: ActionResult[], mutationIndex: number): boolean {
  for (let index = history.length - 1; index > mutationIndex; index--) {
    const result = history[index];
    if (result?.action.kind === "tool_call" && result.action.toolName === "completion_check") return true;
  }
  return false;
}

function findLatestSuccessfulWorkspaceMutationBefore(
  history: ActionResult[],
  beforeIndex: number,
): { index: number; result: ActionResult } | null {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const result = history[index];
    if (result?.ok === true && result.metadata?.workspaceMutation === true) {
      return { index, result };
    }
  }
  return null;
}

function findLatestValidationAfterMutation(history: ActionResult[], mutationIndex: number): ActionResult | null {
  for (let index = history.length - 1; index > mutationIndex; index--) {
    const result = history[index];
    if (result?.action.kind === "tool_call" && result.action.toolName === "run_validation") {
      return result;
    }
  }
  return null;
}

type CompletionCheckPayload = {
  status: string;
  repeatedActionPrevented?: boolean;
  action?: {
    toolName?: string;
    target?: string;
    label?: string;
  };
  validation?: {
    ok?: boolean;
    summary?: string;
  } | null;
};

function finalizeDanglingCompletionCheck(state: LoopState): void {
  if (state.stopReason) return;
  const completionCheck = parseCompletionCheckPayload(state.lastResult);
  if (!completionCheck) return;

  const feedback = buildCompletionCheckFeedback(completionCheck);
  const failed = completionCheck.status === "needs_repair" || completionCheck.validation?.ok === false;
  const action: BrainDecision["action"] = failed
    ? { kind: "fail", reason: feedback }
    : { kind: "respond", content: feedback };
  const result: ActionResult = {
    action,
    ok: !failed,
    output: feedback,
    ...(failed ? { error: feedback } : {}),
    metadata: {
      category: failed ? "runtime_error" : "assistant_response",
      summary: feedback,
      retryable: false,
      syntheticFinalFeedback: true,
    },
  };

  state.lastDecision = {
    action,
    reasoning: "Runtime finalized a dangling completion_check so the run stops with user-facing feedback.",
  };
  state.lastResult = result;
  state.history.push(result);
  state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, result);
  state.stopReason = failed ? "fail" : "respond";
  state.stopSummary = feedback;
}

function parseCompletionCheckPayload(result: ActionResult | null): CompletionCheckPayload | null {
  if (!result || result.action.kind !== "tool_call" || result.action.toolName !== "completion_check") {
    return null;
  }
  if (!result.output || typeof result.output !== "object") return null;
  const output = result.output as {
    status?: unknown;
    repeatedActionPrevented?: unknown;
    action?: { toolName?: unknown; target?: unknown; label?: unknown };
    validation?: { ok?: unknown; summary?: unknown } | null;
  };
  const status = typeof output.status === "string" ? output.status : "";
  if (!status) return null;
  const repeatedActionPrevented = typeof output.repeatedActionPrevented === "boolean" ? output.repeatedActionPrevented : undefined;
  const action = output.action && typeof output.action === "object"
    ? {
        ...(typeof output.action.toolName === "string" ? { toolName: output.action.toolName } : {}),
        ...(typeof output.action.target === "string" ? { target: output.action.target } : {}),
        ...(typeof output.action.label === "string" ? { label: output.action.label } : {}),
      }
    : undefined;
  const validation = output.validation && typeof output.validation === "object"
    ? {
        ...(typeof output.validation.ok === "boolean" ? { ok: output.validation.ok } : {}),
        ...(typeof output.validation.summary === "string" ? { summary: output.validation.summary } : {}),
      }
    : output.validation === null
      ? null
      : undefined;
  return { status, ...(repeatedActionPrevented !== undefined ? { repeatedActionPrevented } : {}), ...(action ? { action } : {}), ...(validation !== undefined ? { validation } : {}) };
}

function buildCompletionCheckFeedback(payload: CompletionCheckPayload): string {
  const toolName = payload.action?.toolName ?? "tool";
  const label = payload.action?.label ?? labelWorkspaceActionSafe(toolName);
  const target = payload.action?.target;
  const validationSummary = summarizeCompletionValidation(payload.validation);
  const repeatedActionPrevented = payload.repeatedActionPrevented !== false;

  if (payload.status === "needs_repair" || payload.validation?.ok === false) {
    if (repeatedActionPrevented) {
      return target
        ? `已停止重复执行：${target} 已${label}，但验证没有通过。${validationSummary} 请换一种修复方式继续。`
        : `已停止重复执行：工具动作已经执行，但验证没有通过。${validationSummary} 请换一种修复方式继续。`;
    }
    return target
      ? `${target} 已${label}，但验证没有通过。${validationSummary} 请换一种修复方式继续。`
      : `工具动作已经执行，但验证没有通过。${validationSummary} 请换一种修复方式继续。`;
  }

  if (!repeatedActionPrevented) {
    return target
      ? `已完成：${target} 已${label}。${validationSummary}`
      : `已完成：${toolName} 动作已经执行。${validationSummary}`;
  }

  return target
    ? `已完成：${target} 已${label}。${validationSummary} 我已停止重复执行相同工具。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 我已停止重复执行相同工具。`;
}

function buildCompletionGateFeedback(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
): string {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const validationFailed = latestValidation ? validationDidFail(latestValidation) : false;
  const validationSummary = latestValidation
    ? summarizeValidationResult(latestValidation) ?? (validationFailed ? "验证未通过。" : "验证已完成。")
    : "没有检测到额外验证步骤。";
  const label = labelWorkspaceActionSafe(toolName);

  if (validationFailed) {
    return target
      ? `文件已${label}：${target}，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`
      : `工具动作已经执行，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`;
  }

  return target
    ? `已完成：${target} 已${label}。${validationSummary} 无需再次执行同一个写入动作。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 无需再次执行同一个工具动作。`;
}

function summarizeCompletionValidation(validation: CompletionCheckPayload["validation"]): string {
  const summary = validation?.summary?.trim();
  if (summary) return `验证结果：${summary}`;
  if (validation?.ok === true) return "验证已通过。";
  if (validation?.ok === false) return "验证未通过。";
  return "没有检测到额外验证步骤。";
}

function labelWorkspaceActionSafe(toolName: string): string {
  if (toolName === "delete_path") return "删除";
  if (toolName === "move_path") return "移动";
  if (toolName === "copy_path") return "复制";
  if (toolName === "patch_text_file") return "修改";
  if (toolName === "write_text_file") return "写入/更新";
  return "处理";
}

function buildDuplicateWorkspaceMutationFeedback(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
): string {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const actionLabel = labelWorkspaceAction(toolName);

  if (latestValidation && validationDidFail(latestValidation)) {
    const validationSummary = summarizeValidationResult(latestValidation) ?? "验证未通过。";
    return target
      ? `文件已${actionLabel}：${target}，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`
      : `工具动作已经执行，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`;
  }

  const validationSummary = latestValidation
    ? summarizeValidationResult(latestValidation) ?? "验证已完成。"
    : "没有检测到额外验证步骤。";

  return target
    ? `已完成：${target} 已${actionLabel}。${validationSummary} 无需再次执行同一个写入动作。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 无需再次执行同一个工具动作。`;
}

function validationDidFail(result: ActionResult): boolean {
  if (result.ok === false) return true;
  if (!result.output || typeof result.output !== "object") return false;
  return (result.output as { ok?: unknown }).ok === false;
}

function summarizeValidationResult(result: ActionResult): string | null {
  if (!result.output || typeof result.output !== "object") {
    return result.metadata?.summary ?? null;
  }

  const output = result.output as { ok?: unknown; summary?: unknown; mode?: unknown };
  const summary = typeof output.summary === "string" && output.summary.trim()
    ? output.summary.trim()
    : result.metadata?.summary;

  if (output.ok === true) return summary ?? "验证已通过。";
  if (output.ok === false) return summary ?? "验证未通过。";
  return summary ?? null;
}

function labelWorkspaceAction(toolName: string): string {
  if (toolName === "delete_path") return "删除";
  if (toolName === "move_path") return "移动";
  if (toolName === "copy_path") return "复制";
  if (toolName === "patch_text_file") return "修改";
  if (toolName === "write_text_file") return "写入/更新";
  return "处理";
}

function inferWorkspaceActionTarget(action: BrainDecision["action"]): string | null {
  if (!action.toolInput || typeof action.toolInput !== "object") return null;
  const input = action.toolInput as Record<string, unknown>;
  for (const key of ["path", "destinationPath", "sourcePath"]) {
    if (typeof input[key] === "string" && input[key].length > 0) return input[key] as string;
  }
  return null;
}

function inferOutputPath(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const value = (output as Record<string, unknown>).path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findDuplicateSuccessfulWorkspaceMutation(
  decision: BrainDecision,
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
): { index: number; result: ActionResult } | null {
  const signature = toolActionSignature(decision.action);
  if (!signature) return null;
  if (!isRepeatProtectedWorkspaceAction(decision.action, availableTools)) return null;

  for (let index = history.length - 1; index >= 0; index--) {
    const result = history[index];
    if (!result) continue;
    if (
      result.ok === true
      && isRepeatProtectedWorkspaceAction(result.action, availableTools)
      && toolActionSignature(result.action) === signature
    ) {
      return { index, result };
    }
  }

  return null;
}

function inferReadOnlyRecoveryDecision(
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
  repeatedToolName: string,
  message: string,
): BrainDecision | null {
  if (repeatedToolName === "web_search" && hasTool(availableTools, "web_fetch")) {
    const url = inferLatestUnfetchedSearchResultUrl(history);
    if (url) {
      return {
        action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url } },
        reasoning: `Recovery: web_search already produced candidates; fetching ${url} instead of repeating the same search.`,
      };
    }
  }

  if (repeatedToolName === "web_fetch" && hasTool(availableTools, "web_search")) {
    return {
      action: { kind: "tool_call", toolName: "web_search", toolInput: { query: buildRecoveryWebSearchQuery(message, history), limit: 5 } },
      reasoning: "Recovery: repeated web_fetch did not add new article evidence; searching for an alternate accessible source.",
    };
  }

  if (hasTool(availableTools, "read_text_file")) {
    const keyPath = inferNextKeyReadPath(history);
    if (keyPath) {
      return {
        action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: keyPath } },
        reasoning: `Recovery: reading key file ${keyPath} instead of repeating a read-only discovery tool.`,
      };
    }
  }

  if (hasTool(availableTools, "inspect_project") && !hasRecentTool(history, "inspect_project")) {
    return {
      action: { kind: "tool_call", toolName: "inspect_project", toolInput: {} },
      reasoning: "Recovery: using inspect_project to summarize the workspace instead of repeating directory listing.",
    };
  }

  if (hasTool(availableTools, "code_map") && !hasRecentTool(history, "code_map")) {
    return {
      action: { kind: "tool_call", toolName: "code_map", toolInput: { maxFiles: 1200, includeTests: false } },
      reasoning: "Recovery: using code_map to locate entrypoints and framework structure.",
    };
  }

  return null;
}

function inferLatestUnfetchedSearchResultUrl(history: ActionResult[]): string | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const result = history[index];
    if (!result?.ok || result.action.kind !== "tool_call") continue;
    if ((result.metadata?.toolName ?? result.action.toolName) !== "web_search") continue;
    const url = inferFirstWebSearchResultUrl(result.output);
    if (url && !hasFetchedWebUrl(history, url)) return url;
  }
  return null;
}

function inferFirstWebSearchResultUrl(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function hasFetchedWebUrl(history: ActionResult[], url: string): boolean {
  return history.some((result) => {
    if (result.action.kind !== "tool_call") return false;
    if ((result.metadata?.toolName ?? result.action.toolName) !== "web_fetch") return false;
    const input = result.action.toolInput as { url?: unknown } | null;
    const output = result.output as { url?: unknown; finalUrl?: unknown } | null;
    return input?.url === url || output?.url === url || output?.finalUrl === url;
  });
}

function buildRecoveryWebSearchQuery(message: string, history: ActionResult[]): string {
  const latestSearch = [...history].reverse().find((result) => {
    return result.action.kind === "tool_call" && (result.metadata?.toolName ?? result.action.toolName) === "web_search";
  });
  const outputQuery = latestSearch?.output && typeof latestSearch.output === "object" && !Array.isArray(latestSearch.output)
    ? (latestSearch.output as { query?: unknown }).query
    : undefined;
  const inputQuery = latestSearch?.action.kind === "tool_call" && latestSearch.action.toolInput && typeof latestSearch.action.toolInput === "object"
    ? (latestSearch.action.toolInput as { query?: unknown }).query
    : undefined;
  const query = typeof outputQuery === "string" && outputQuery.trim()
    ? outputQuery
    : typeof inputQuery === "string" && inputQuery.trim()
      ? inputQuery
      : message;
  return query
    .replace(/https?:\/\/[^\s"'<>，。！？、]+/gi, " ")
    .replace(/联网搜索|网页搜索|搜索|搜一下|查一下|看一下|帮我|能不能|可以|吗/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "网页正文 候选来源";
}

function buildReadOnlyCompletionFeedback(
  history: ActionResult[],
  message: string,
  repeatedToolName: string,
): string | null {
  const latest = findLatestSuccessfulReadOnlyObservation(history);
  if (!latest) return null;

  const latestToolName = latest.metadata?.toolName ?? latest.action.toolName ?? repeatedToolName;
  const summary = summarizeReadOnlyObservation(latest, message);
  if (!summary) return null;

  return [
    `已停止重复调用 ${repeatedToolName}，因为继续执行同一个只读动作不会增加新信息。`,
    `我先根据目前拿到的 ${latestToolName} 结果给你反馈：`,
    summary,
  ].join("\n\n");
}

function findLatestSuccessfulReadOnlyObservation(history: ActionResult[]): ActionResult | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const result = history[index];
    if (!result?.ok || result.action.kind !== "tool_call") continue;
    if (result.metadata?.workspaceMutation === true) continue;
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    if (!toolName || toolName === "run_validation" || toolName === "completion_check") continue;
    return result;
  }
  return null;
}

function summarizeReadOnlyObservation(result: ActionResult, message: string): string | null {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  if (toolName === "read_text_file") {
    const output = result.output as { path?: unknown; content?: unknown; truncated?: unknown } | null;
    const path = typeof output?.path === "string" ? output.path : "目标文件";
    const content = typeof output?.content === "string" ? output.content.trim() : "";
    const preview = content ? content.slice(0, 900) : result.metadata?.summary ?? "";
    const truncated = output?.truncated === true || content.length > 900 ? "\n\n内容较长，这里先给出已读取内容的前半部分。" : "";
    return `已读取 ${path}。${truncated}\n\n${preview}`;
  }

  if (toolName === "web_fetch") {
    const output = result.output as {
      url?: unknown;
      title?: unknown;
      text?: unknown;
      content?: unknown;
      htmlPreview?: unknown;
      articleCandidates?: Array<{ text?: unknown; source?: unknown; score?: unknown }>;
      truncated?: unknown;
      htmlPreviewTruncated?: unknown;
    } | null;
    const title = typeof output?.title === "string" && output.title.trim() ? output.title.trim() : "网页";
    const url = typeof output?.url === "string" ? output.url : "";
    const bestCandidate = Array.isArray(output?.articleCandidates)
      ? output.articleCandidates
        .map((candidate) => typeof candidate.text === "string" ? candidate.text.trim() : "")
        .find((text) => text.length > 0)
      : "";
    const content = [
      bestCandidate ?? "",
      typeof output?.text === "string" ? output.text.trim() : "",
      typeof output?.content === "string" ? output.content.trim() : "",
      typeof output?.htmlPreview === "string" ? output.htmlPreview.trim() : "",
    ].find((value) => value.length > 0) ?? "";
    const preview = content.slice(0, 1200);
    const truncated = output?.truncated === true || output?.htmlPreviewTruncated === true || content.length > 1200
      ? "\n\n网页内容较长，我先整理前半部分；如果你要完整正文，可以继续让我拉取/归纳剩余部分。"
      : "";
    return `已抓取 ${title}${url ? `：${url}` : ""}。\n\n${preview || "页面返回了内容，但没有提取到稳定正文。可以换一个链接，或让我继续尝试从 HTML 候选块里筛正文。"}${truncated}`;
  }

  if (toolName === "web_search") {
    const output = result.output as { query?: unknown; provider?: unknown; results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown }> } | null;
    const query = typeof output?.query === "string" ? output.query : message.trim();
    const provider = typeof output?.provider === "string" ? `（${output.provider}）` : "";
    const results = Array.isArray(output?.results) ? output.results : [];
    if (results.length === 0) return `已联网搜索${provider}「${query}」，但没有拿到可用结果。`;
    const lines = results.slice(0, 5).map((item, index) => {
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "未命名结果";
      const url = typeof item.url === "string" && item.url.trim() ? item.url.trim() : "";
      const snippet = typeof item.snippet === "string" && item.snippet.trim() ? `\n   ${item.snippet.trim()}` : "";
      return `${index + 1}. ${title}${url ? `\n   ${url}` : ""}${snippet}`;
    });
    return `已联网搜索${provider}「${query}」，结果如下：\n${lines.join("\n")}`;
  }

  if (toolName === "inspect_project" || toolName === "code_map" || toolName === "list_directory" || toolName === "search_workspace") {
    return result.metadata?.summary
      ? `已完成 ${toolName}：${result.metadata.summary}`
      : `已完成 ${toolName}，但结果较结构化，请补充你要看的具体文件或目标，我会接着分析。`;
  }

  return result.metadata?.summary ?? null;
}

function toolActionSignature(action: BrainDecision["action"]): string | null {
  if ((action.kind !== "tool_call" && action.kind !== "needs_approval") || !action.toolName) return null;
  return `${action.toolName}:${stableJson(action.toolInput ?? null)}`;
}

const REPEAT_PROTECTED_READ_ONLY_TOOLS = new Set([
  "list_directory",
  "inspect_project",
  "search_workspace",
  "code_map",
  "dependency_graph",
  "symbol_search",
]);

function isRepeatProtectedReadOnlyAction(
  action: BrainDecision["action"],
  availableTools: BrainInput["availableTools"],
): boolean {
  if (action.kind !== "tool_call" || !action.toolName) return false;
  if (action.toolName === "run_validation" || action.toolName === "completion_check") return false;
  if (isRepeatProtectedWorkspaceAction(action, availableTools)) return false;
  if (REPEAT_PROTECTED_READ_ONLY_TOOLS.has(action.toolName)) return true;

  const descriptor = availableTools.find((tool) => tool.name === action.toolName);
  return descriptor?.risk === "read" && descriptor.effects?.workspaceMutation !== true;
}

const REPEAT_PROTECTED_WORKSPACE_TOOLS = new Set([
  "copy_path",
  "delete_path",
  "move_path",
  "patch_text_file",
  "write_text_file",
]);

function isRepeatProtectedWorkspaceAction(
  action: BrainDecision["action"],
  availableTools: BrainInput["availableTools"],
): boolean {
  if ((action.kind !== "tool_call" && action.kind !== "needs_approval") || !action.toolName) return false;
  if (REPEAT_PROTECTED_WORKSPACE_TOOLS.has(action.toolName)) return true;

  const descriptor = availableTools.find((tool) => tool.name === action.toolName);
  return descriptor?.effects?.workspaceMutation === true;
}

function hasTool(availableTools: BrainInput["availableTools"], name: string): boolean {
  return availableTools.some((tool) => tool.name === name);
}

function latestUserMessage(input: BrainInput): string {
  return [...input.context.volatile].reverse().find((item) => item.kind === "user_turn")?.content
    ?? input.context.volatile.find((item) => item.kind === "user_turn")?.content
    ?? "";
}

function hasRecentTool(history: ActionResult[], toolName: string): boolean {
  return history.slice(-8).some((result) => result.action.kind === "tool_call" && result.action.toolName === toolName);
}

function inferNextKeyReadPath(history: ActionResult[]): string | null {
  const readPaths = new Set(
    history
      .map((result) => result.action.kind === "tool_call" && result.action.toolName === "read_text_file"
        ? inferOutputPath(result.output)
        : null)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );
  const candidates = collectKeyReadCandidates(history);
  return candidates.find((path) => !readPaths.has(path)) ?? null;
}

function collectKeyReadCandidates(history: ActionResult[]): string[] {
  const paths: string[] = [];
  for (const result of history) {
    if (!result.ok || result.action.kind !== "tool_call") continue;
    const toolName = result.action.toolName;
    if (toolName === "list_directory") {
      const output = result.output as { entries?: Array<{ path?: unknown; kind?: unknown }> } | null;
      if (Array.isArray(output?.entries)) {
        for (const entry of output.entries) {
          if (typeof entry.path === "string" && entry.kind === "file") paths.push(toPortablePath(entry.path));
        }
      }
    }
    if (toolName === "inspect_project") {
      const output = result.output as { topLevelEntries?: Array<{ path?: unknown; kind?: unknown }> } | null;
      if (Array.isArray(output?.topLevelEntries)) {
        for (const entry of output.topLevelEntries) {
          if (typeof entry.path === "string" && entry.kind === "file") paths.push(toPortablePath(entry.path));
        }
      }
    }
    if (toolName === "search_workspace") {
      const output = result.output as { results?: Array<{ file?: unknown }> } | null;
      if (Array.isArray(output?.results)) {
        for (const entry of output.results) {
          if (typeof entry.file === "string") paths.push(toPortablePath(entry.file));
        }
      }
    }
    if (toolName === "code_map") {
      const output = result.output as { entrypoints?: Array<{ path?: unknown } | string> } | null;
      if (Array.isArray(output?.entrypoints)) {
        for (const entry of output.entrypoints) {
          if (typeof entry === "string") paths.push(toPortablePath(entry));
          else if (typeof entry?.path === "string") paths.push(toPortablePath(entry.path));
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
  const normalized = toPortablePath(path).toLowerCase();
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

function toPortablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stableJson(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
  return `{${entries.join(",")}}`;
}

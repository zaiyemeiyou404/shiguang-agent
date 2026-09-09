import type { BrainInput, ActionResult, TaskLoopEvidenceKind, TaskLoopEvidenceQuality } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";
import { inferToolContract } from "../tools/contract.js";

const DEFAULT_MAX_SELECTED_TOOLS = 14;
interface EvidenceLogEntry {
  step: number;
  toolName: string;
  kind: TaskLoopEvidenceKind;
  quality: TaskLoopEvidenceQuality;
  target?: string;
  summary: string;
}

const CORE_INSPECTION_TOOLS = new Set([
  "inspect_project",
  "list_directory",
  "stat_path",
  "find_files",
  "read_text_file",
  "read_many_files",
  "search_workspace",
  "code_map",
  "symbol_search",
  "dependency_graph",
]);

const CORE_EDIT_TOOLS = new Set([
  "write_text_file",
  "patch_text_file",
  "copy_path",
  "move_path",
  "delete_path",
]);

const CORE_VALIDATE_TOOLS = new Set([
  "run_validation",
  "run_terminal_command",
  "git_status",
  "git_diff",
  "collect_diagnostics",
]);

export interface ToolSelection {
  selected: ToolDescriptor[];
  total: number;
  omitted: number;
}

export function selectToolsForPlanner(
  input: BrainInput,
  maxSelected = DEFAULT_MAX_SELECTED_TOOLS,
): ToolSelection {
  const tools = input.availableTools;
  const latestText = latestUserText(input).toLowerCase();
  const text = buildIntentText(input);
  const intentText = latestText || text;
  const intent = classifyIntent(intentText, input.history);
  const route = classifyToolRoute(
    latestText || intentText,
    input.workingMemory?.taskLoop?.mode,
    input.workingMemory?.taskLoop?.taskKind ?? input.workingMemory?.taskLoop?.userCommand?.taskKind,
  );
  if (tools.length <= maxSelected) {
    const selected = narrowToolsForDominantIntent(applyHardRouteGate(tools, route), intent, intentText, input);
    return { selected, total: tools.length, omitted: Math.max(0, tools.length - selected.length) };
  }
  const recentToolNames = new Set(
    input.history
      .slice(-6)
      .map((result) => result.metadata?.toolName ?? result.action.toolName)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  const recentSignatures = new Set(
    input.history
      .slice(-8)
      .map((result) => toolActionSignature(result.action))
      .filter((signature): signature is string => Boolean(signature)),
  );
  const recentFailedToolNames = new Set(
    input.history
      .slice(-6)
      .filter((result) => result.ok === false)
      .map((result) => result.metadata?.toolName ?? result.action.toolName)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
  const recommendedNextTools = inferRecommendedNextTools(input.history);
  const taskLoopRecommendedTools = inferTaskLoopRecommendedTools(input);
  const recentEvidenceLog = input.workingMemory?.taskLoop?.evidenceLog?.slice(-6) ?? [];
  for (const toolName of taskLoopRecommendedTools) {
    recommendedNextTools.add(toolName);
  }
  const taskLoopCostPressure = inferTaskLoopCostPressure(input);

  const scored = tools.map((tool, index) => ({
    tool,
    index,
    score: scoreTool(tool, intent, recentToolNames, recentSignatures, recentFailedToolNames, recommendedNextTools, taskLoopRecommendedTools, recentEvidenceLog, taskLoopCostPressure, input.history, intentText),
  }));

  const gatedTools = applyHardRouteGate(tools, route);
  const gatedNames = new Set(gatedTools.map((tool) => tool.name));
  const selected = narrowToolsForDominantIntent(ensurePinnedTools(
    scored,
    scored
      .filter((item) => gatedNames.has(item.tool.name))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, Math.max(1, maxSelected))
      .sort((left, right) => left.index - right.index)
      .map((item) => item.tool),
    [...pinnedToolsForIntent(intent, text), ...taskLoopRecommendedTools],
    maxSelected,
  ), intent, intentText, input);

  return {
    selected,
    total: tools.length,
    omitted: Math.max(0, tools.length - selected.length),
  };
}

type ToolRoute = "web" | "workspace" | "open";

function classifyToolRoute(text: string, taskMode?: string, taskKind?: string): ToolRoute {
  if (taskKind === "web_search" || taskKind === "web_article") return "web";
  if (
    taskKind === "file_transform"
    || taskKind === "file_read"
    || taskKind === "workspace_overview"
    || taskKind === "code_analysis"
    || taskKind === "debug"
    || taskKind === "edit"
    || taskKind === "validation"
  ) return "workspace";
  if (taskMode === "web") return "web";
  if (taskMode === "workspace" || taskMode === "edit" || taskMode === "validation") return "workspace";
  if (isExplicitUrlText(text)) return "web";

  const normalized = text.toLowerCase();
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory/.test(normalized);
  const localFileTask = localIntent && /翻译|总结|改写|润色|读取|查看|分析|处理|保存|修改|编辑|translate|summari[sz]e|rewrite|polish/.test(normalized);
  const explicitWeb = /联网|上网|网上|网页|网址|链接|抓取网页|网页搜索|网络搜索|搜索网页|官网|新闻|最新|最近|当前|url|online|web|latest|current/.test(normalized);
  const searchIntent = /搜|搜索|查一下|查询|查找|检索|look up|search|find/.test(normalized);

  if (localFileTask || (localIntent && !explicitWeb)) return "workspace";
  if (explicitWeb || (searchIntent && !localIntent)) return "web";
  return "open";
}

function applyHardRouteGate(tools: ToolDescriptor[], route: ToolRoute): ToolDescriptor[] {
  if (route === "web") {
    const webTools = tools.filter((tool) => isWebToolForTask(tool));
    return webTools.length > 0 ? webTools : tools;
  }
  if (route === "workspace") {
    const localTools = tools.filter((tool) => !isWebToolForTask(tool));
    return localTools.length > 0 ? localTools : tools;
  }
  return tools;
}

function narrowToolsForDominantIntent(
  selected: ToolDescriptor[],
  intent: IntentFlags,
  text: string,
  input: BrainInput,
): ToolDescriptor[] {
  const taskMode = input.workingMemory?.taskLoop?.mode;
  if (taskMode === "web" || (intent.web && isExplicitUrlText(text))) {
    const webTools = selected.filter((tool) => isWebToolForTask(tool));
    return webTools.length > 0 ? webTools : selected;
  }

  if ((taskMode === "workspace" || taskMode === "edit" || taskMode === "validation") && !intent.web) {
    const localTools = selected.filter((tool) => !isWebToolForTask(tool));
    return localTools.length > 0 ? localTools : selected;
  }

  return selected;
}

function isWebToolForTask(tool: ToolDescriptor): boolean {
  const contract = tool.contract ?? inferToolContract(tool);
  return tool.name === "web_fetch"
    || tool.name === "web_search"
    || tool.name === "web_extract_links"
    || contract.category === "web"
    || contract.category === "github";
}

function buildIntentText(input: BrainInput): string {
  const userTurn = [...input.context.volatile].reverse().find((item) => item.kind === "user_turn")?.content ?? "";
  const lastSummary = input.workingMemory?.lastObservation?.summary ?? "";
  const lastTool = input.workingMemory?.lastToolName ?? "";
  const evidence = (input.workingMemory?.taskLoop?.evidenceLog ?? [])
    .slice(-4)
    .map((entry) => `${entry.toolName} ${entry.quality} ${entry.kind} ${entry.target ?? ""} ${entry.summary}`)
    .join("\n");
  return `${userTurn}\n${lastSummary}\n${lastTool}\n${evidence}`.toLowerCase();
}

interface IntentFlags {
  inspect: boolean;
  edit: boolean;
  validate: boolean;
  web: boolean;
  memory: boolean;
  git: boolean;
  mcp: boolean;
  execute: boolean;
  adaptive?: boolean;
}

function classifyIntent(text: string, history: ActionResult[]): IntentFlags {
  const hadMutation = history.some((result) => result.metadata?.workspaceMutation === true);
  const readableIntent = classifyReadableChineseIntent(text, hadMutation);
  if (readableIntent) {
    return {
      ...readableIntent,
      adaptive: inferAdaptiveLearningIntent(text),
    };
  }
  const explicitWebIntent = /网页|联网|上网|网上|网络搜索|网页搜索|搜索网页|搜索网络|搜一下|搜搜|搜索一下|查一下|查找一下|检索|官网|新闻|资料|文档|github|release|url|http|https|web|fetch|search online|browser|online|latest|current/.test(text);
  const freshnessIntent = /最新|最近|今天|当前|现在|价格|版本|发布|release|latest|current|today|recent/.test(text);
  const searchIntent = /搜|搜索|查|查询|查找|检索|look up|search|find/.test(text);
  return {
    inspect: /看|查看|分析|理解|梳理|检查|inspect|read|search|find|analy[sz]e|explain|map/.test(text),
    edit: /改|修|写|创建|生成|删除|移动|重命名|保存|fix|edit|write|create|delete|move|rename|patch|implement/.test(text),
    validate: hadMutation || /运行|测试|验证|打包|构建|报错|run|test|typecheck|build|validate|package|error/.test(text),
    web: explicitWebIntent || (searchIntent && freshnessIntent),
    memory: /记忆|记住|忘记|偏好|memory|remember|forget|preference/.test(text),
    git: /git|提交|差异|diff|status|commit|github|release|仓库/.test(text),
    mcp: /mcp|数据源|database|api|connector|server|tool/.test(text),
    execute: /命令|终端|脚本|执行|启动|install|npm|pnpm|yarn|pip|command|terminal|shell/.test(text),
  };
}

function inferAdaptiveLearningIntent(text: string): boolean {
  return /错|不对|为什么|啥意思|不是|应该|质疑|反思|总结|保存|记住|规则|学一下|学习|降智|混乱|重复|没用|没有|wrong|incorrect|why|reflect|learn|rule|memory|remember|hermes/.test(text);
}

function classifyReadableChineseIntent(text: string, hadMutation: boolean): IntentFlags | null {
  if (!/[\u4e00-\u9fff]/.test(text)) return null;
  const searchIntent = /搜索|搜一下|搜搜|查一下|查询|查找|检索|找一下|找找/.test(text);
  const localWorkspaceIntent = /工作区|本地|目录|文件|项目|代码|仓库|工程/.test(text);
  const explicitWebIntent = /https?:\/\/|网页|网址|链接|文章|正文|抓取|联网|上网|网上|网络搜索|网页搜索|搜索网页|搜索网络|联网查|官网|新闻|资料|文档|最新|最近|今天|当前|现在|价格|版本|发布|url|web|online/.test(text);
  const inspectIntent = /看|查看|分析|理解|梳理|检查/.test(text);
  const validateIntent = /运行|测试|验证|打包|构建|报错|杩愯|娴嬭瘯|楠岃瘉|鎵撳寘|鏋勫缓/.test(text);
  const pathIntent = /(?:^|[\s"'(])[\w.-]+[\\/][\w./\\-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|py|md|css|html|dart|yaml|yml)\b/.test(text);
  const editIntent = /改|修改|写|创建|生成|删除|移动|重命名|保存|淇|鏀|鍐|鍒涘缓|鐢熸垚/.test(text) || (pathIntent && validateIntent);
  const memoryIntent = /记忆|记住|忘记|偏好/.test(text);
  const gitIntent = /提交|差异|仓库/.test(text);
  const mcpIntent = /数据源|工具协议|连接器/.test(text);
  const executeIntent = /命令|终端|脚本|执行|启动/.test(text);
  if (!(searchIntent || localWorkspaceIntent || explicitWebIntent || inspectIntent || editIntent || validateIntent || memoryIntent || gitIntent || mcpIntent || executeIntent)) {
    return null;
  }

  return {
    inspect: inspectIntent || searchIntent,
    edit: editIntent,
    validate: hadMutation || validateIntent,
    web: explicitWebIntent || (searchIntent && !localWorkspaceIntent),
    memory: memoryIntent,
    git: gitIntent,
    mcp: mcpIntent,
    execute: executeIntent,
  };
}

function pinnedToolsForIntent(intent: IntentFlags, text: string): string[] {
  const pinned: string[] = [];
  if (intent.web) pinned.push("web_search", "web_fetch");
  if (intent.web && /正文|文章|全文|链接|网页|抓取|article|body|link|html/i.test(text)) pinned.push("web_extract_links");
  if (intent.adaptive || intent.memory || inferAdaptiveLearningIntent(text)) {
    pinned.push("record_agent_rule", "list_custom_extensions");
  }
  return pinned;
}

function ensurePinnedTools(
  scored: Array<{ tool: ToolDescriptor; index: number; score: number }>,
  selected: ToolDescriptor[],
  pinnedToolNames: string[],
  maxSelected: number,
): ToolDescriptor[] {
  if (pinnedToolNames.length === 0) return selected;
  const next = [...selected];
  for (const pinnedName of pinnedToolNames) {
    if (next.some((tool) => tool.name === pinnedName)) continue;
    const pinned = scored.find((item) => item.tool.name === pinnedName)?.tool;
    if (!pinned) continue;
    if (next.length >= maxSelected) {
      const removableIndex = findLowestPriorityNonPinnedIndex(next, scored, pinnedToolNames);
      if (removableIndex >= 0) {
        next.splice(removableIndex, 1);
      } else {
        continue;
      }
    }
    next.push(pinned);
  }
  return next.sort((left, right) => {
    const leftIndex = scored.find((item) => item.tool.name === left.name)?.index ?? 0;
    const rightIndex = scored.find((item) => item.tool.name === right.name)?.index ?? 0;
    return leftIndex - rightIndex;
  });
}

function findLowestPriorityNonPinnedIndex(
  selected: ToolDescriptor[],
  scored: Array<{ tool: ToolDescriptor; index: number; score: number }>,
  pinnedToolNames: string[],
): number {
  let lowestIndex = -1;
  let lowestScore = Infinity;
  for (let index = 0; index < selected.length; index++) {
    const tool = selected[index];
    if (!tool || pinnedToolNames.includes(tool.name)) continue;
    const score = scored.find((item) => item.tool.name === tool.name)?.score ?? 0;
    if (score < lowestScore) {
      lowestScore = score;
      lowestIndex = index;
    }
  }
  return lowestIndex;
}

function scoreTool(
  tool: ToolDescriptor,
  intent: IntentFlags,
  recentToolNames: Set<string>,
  recentSignatures: Set<string>,
  recentFailedToolNames: Set<string>,
  recommendedNextTools: Set<string>,
  taskLoopRecommendedTools: Set<string>,
  recentEvidenceLog: EvidenceLogEntry[],
  taskLoopCostPressure: "normal" | "high",
  history: ActionResult[],
  text: string,
): number {
  const name = tool.name;
  const haystack = `${tool.name} ${tool.capability ?? ""} ${tool.description}`.toLowerCase();
  const contract = tool.contract ?? inferToolContract(tool);
  let score = 0;

  if (CORE_INSPECTION_TOOLS.has(name)) score += intent.inspect || !intent.edit ? 24 : 12;
  if (CORE_EDIT_TOOLS.has(name)) score += intent.edit ? 26 : 3;
  if (CORE_VALIDATE_TOOLS.has(name)) score += intent.validate || intent.execute || intent.git ? 22 : 8;
  if (contract.phase === "inspect" || contract.phase === "read") score += intent.inspect || !intent.edit ? 8 : 2;
  if (contract.phase === "edit") score += intent.edit ? 10 : -6;
  if (contract.phase === "verify") score += intent.validate ? 10 : 3;
  if (contract.phase === "execute") score += intent.execute || intent.validate ? 8 : -4;
  if (name === "run_validation" && history.some((result) => result.metadata?.workspaceMutation === true)) score += 20;
  if (recommendedNextTools.has(name)) score += 18;
  if (taskLoopRecommendedTools.has(name)) score += 28;
  score += scoreEvidenceLedgerFit(name, recentEvidenceLog, taskLoopRecommendedTools);
  if (recentToolNames.has(name)) score += 4;
  if (recentFailedToolNames.has(name)) score -= 18;
  if (tool.requiresApproval === true && !intent.edit && !intent.execute) score -= 8;

  if (intent.web && (contract.category === "web" || contract.category === "github" || haystack.includes("fetch"))) score += 24;
  if (intent.web && name === "web_search") score += 36;
  if (intent.web && name === "web_fetch" && /url|http|https|网页|网址|链接|文章|正文|抓取|fetch/.test(text)) score += 54;
  if (intent.web && isExplicitUrlText(text) && name === "web_fetch") score += 42;
  if (intent.web && name === "web_extract_links" && hasWeakWebFetchWithHtmlPreview(history)) score += 64;
  if (intent.web && name === "web_extract_links" && /正文|文章|全文|链接|网页|抓取|article|body|link|html/i.test(text)) score += 18;
  if (!intent.web && name === "read_many_files" && /多个|几个|这些|整体|项目|工程|结构|分析|readme|package|config|入口|multi|several|project|codebase/i.test(text)) score += 22;
  if (!intent.web && name === "find_files" && /找|查找|定位|哪里|哪个|文件名|路径|readme|package|config|入口|\*\.|find|locate|glob|where/i.test(text)) score += 34;
  if (intent.web && isLocalWorkspaceToolName(name)) score -= isExplicitUrlText(text) ? 90 : 48;
  if (!intent.web && (name === "web_search" || name === "web_fetch") && history.some((result) => isRecentWorkspaceEvidence(result))) score -= 18;
  if (intent.memory && contract.category === "memory") score += 24;
  if ((intent.adaptive || intent.memory || inferAdaptiveLearningIntent(text)) && name === "record_agent_rule") score += 42;
  if ((intent.adaptive || intent.memory || inferAdaptiveLearningIntent(text)) && name === "list_custom_extensions") score += 16;
  if (intent.git && (contract.category === "git" || contract.category === "github")) score += 18;
  if (intent.mcp && contract.category === "mcp") score += 18;
  if (intent.execute && contract.category === "process") score += 16;
  if (contract.category === "mcp" && !intent.mcp) score -= 6;
  if ((contract.category === "web" || contract.category === "github") && !intent.web && !intent.git) score -= 8;

  const terms = text
    .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
    .filter((term) => term.length >= 3)
    .slice(0, 20);
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  if (name === "echo") score -= 20;
  if (contract.cost === "medium" && !recentToolNames.has(name)) score -= 2;
  if (contract.cost === "high" && !recentToolNames.has(name)) score -= intent.edit || intent.execute || intent.web || intent.git || intent.mcp ? 3 : 8;
  if (taskLoopCostPressure === "high" && contract.cost === "high" && !taskLoopRecommendedTools.has(name)) score -= 18;
  if (taskLoopCostPressure === "high" && contract.cost === "medium" && !taskLoopRecommendedTools.has(name)) score -= 6;
  if (contract.risk !== "read" && !intent.edit && !intent.execute && !intent.validate) score -= 8;
  if (isRepeatProneToolName(name) && recentToolNames.has(name) && recentSignatures.size > 0) score -= 6;
  return score;
}

function scoreEvidenceLedgerFit(
  toolName: string,
  recentEvidenceLog: EvidenceLogEntry[],
  taskLoopRecommendedTools: Set<string>,
): number {
  const matching = recentEvidenceLog.filter((entry) => entry.toolName === toolName);
  if (matching.length === 0) return 0;

  const weakOrFailed = matching.filter((entry) => entry.quality === "weak" || entry.quality === "failed").length;
  const strong = matching.filter((entry) => entry.quality === "strong").length;
  let score = strong > 0 ? 4 : 0;

  if (weakOrFailed > 0) {
    score -= taskLoopRecommendedTools.has(toolName) ? Math.min(8, weakOrFailed * 4) : Math.min(24, weakOrFailed * 10);
  }
  if (hasRepeatedWeakEvidenceForSameTarget(matching)) {
    if (toolName === "web_fetch") return score - 80;
    score -= taskLoopRecommendedTools.has(toolName) ? 6 : 18;
  }

  return score;
}

function hasRepeatedWeakEvidenceForSameTarget(entries: EvidenceLogEntry[]): boolean {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.quality === "strong") continue;
    const key = `${entry.toolName}:${entry.target ?? ""}`;
    const next = (counts.get(key) ?? 0) + 1;
    if (next >= 2) return true;
    counts.set(key, next);
  }
  return false;
}

function inferTaskLoopRecommendedTools(input: BrainInput): Set<string> {
  const recommended = new Set<string>();
  const taskLoop = input.workingMemory?.taskLoop;
  const tasks = taskLoop?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return recommended;

  const activeTask = tasks.find((task) => task.id === taskLoop?.currentTaskId)
    ?? tasks.find((task) => task.status === "active" || task.status === "blocked");
  if (!activeTask || activeTask.id === "answer") return recommended;

  for (const hint of activeTask.toolHints ?? []) {
    recommended.add(hint);
  }

  const criterion = activeTask.criteria.find((item) => item.status === "pending" || item.status === "failed");
  if (!criterion) return recommended;

  for (const toolName of toolNamesForTaskLoopCriterion(criterion.id, latestUserText(input), taskLoop?.evidenceLog ?? [])) {
    recommended.add(toolName);
  }
  return recommended;
}

function toolNamesForTaskLoopCriterion(
  criterionId: string,
  text: string,
  evidenceLog: EvidenceLogEntry[] = [],
): string[] {
  const hasExplicitUrl = isExplicitUrlText(text);
  switch (criterionId) {
    case "source_located":
      return hasExplicitUrl ? ["web_fetch", "web_search"] : ["web_search", "web_fetch"];
    case "body_evidence":
      if (hasRepeatedWeakEvidenceForSameTarget(evidenceLog.filter((entry) => entry.toolName === "web_fetch"))) {
        return ["web_extract_links", "web_search", "web_fetch"];
      }
      return ["web_fetch", "web_search"];
    case "structure_evidence":
      return ["inspect_project", "find_files", "list_directory", "search_workspace"];
    case "target_evidence":
      return ["find_files", "read_many_files", "read_text_file", "search_workspace", "list_directory"];
    case "key_file_evidence":
      return ["find_files", "read_many_files", "read_text_file", "code_map", "symbol_search"];
    case "workspace_mutated":
      return ["patch_text_file", "write_text_file"];
    case "validation_passed":
      return ["run_validation", "collect_diagnostics"];
    default:
      return [];
  }
}

function isExplicitUrlText(text: string): boolean {
  return /https?:\/\//i.test(text);
}

function inferTaskLoopCostPressure(input: BrainInput): "normal" | "high" {
  const taskLoop = input.workingMemory?.taskLoop;
  if (!taskLoop) return "normal";
  const currentTask = taskLoop.tasks?.find((task) => task.id === taskLoop.currentTaskId);
  if (currentTask?.id === "answer" || taskLoop.needsFinalAnswer === true) return "high";
  if (taskLoop.evidenceCount >= 4 || taskLoop.completionGateCount >= 1) return "high";
  return "normal";
}

function latestUserText(input: BrainInput): string {
  return [...input.context.volatile].reverse().find((item) => item.kind === "user_turn")?.content ?? "";
}

function inferRecommendedNextTools(history: ActionResult[]): Set<string> {
  const recommended = new Set<string>();
  for (const result of history.slice(-4)) {
    if (result.metadata?.workspaceMutation === true) recommended.add("run_validation");
    if (result.action.kind !== "tool_call") continue;
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    if (toolName === "web_search") recommended.add("web_fetch");
    if (toolName === "web_fetch" && result.ok && hasHtmlPreview(result.output)) recommended.add("web_extract_links");
    if (toolName === "web_extract_links") recommended.add("web_fetch");
    if (toolName === "inspect_project" || toolName === "list_directory" || toolName === "search_workspace") {
      recommended.add("find_files");
      recommended.add("read_text_file");
      recommended.add("read_many_files");
      recommended.add("code_map");
    }
    if (toolName === "find_files") {
      recommended.add("read_text_file");
      recommended.add("read_many_files");
    }
    const after = (result.metadata as { recommendedAfterTools?: unknown } | undefined)?.recommendedAfterTools;
    if (Array.isArray(after)) {
      for (const item of after) {
        if (typeof item === "string" && item.trim()) recommended.add(item.trim());
      }
    }
  }
  return recommended;
}

function isRecentWorkspaceEvidence(result: ActionResult): boolean {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  return result.ok === true && (
    toolName === "inspect_project"
    || toolName === "list_directory"
    || toolName === "find_files"
    || toolName === "read_text_file"
    || toolName === "read_many_files"
    || toolName === "search_workspace"
    || toolName === "code_map"
  );
}

function isLocalWorkspaceToolName(name: string): boolean {
  return CORE_INSPECTION_TOOLS.has(name)
    || CORE_EDIT_TOOLS.has(name)
    || name === "run_validation"
    || name === "collect_diagnostics";
}

function isRepeatProneToolName(name: string): boolean {
  return name === "list_directory"
    || name === "find_files"
    || name === "inspect_project"
    || name === "search_workspace"
    || name === "web_search"
    || name === "web_fetch"
    || name === "web_extract_links";
}

function hasWeakWebFetchWithHtmlPreview(history: ActionResult[]): boolean {
  return history.slice(-4).some((result) => {
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    return toolName === "web_fetch" && result.ok === true && hasHtmlPreview(result.output);
  });
}

function hasHtmlPreview(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const html = (output as { htmlPreview?: unknown }).htmlPreview;
  return typeof html === "string" && html.trim().length > 80;
}

function toolActionSignature(action: ActionResult["action"]): string | null {
  if (action.kind !== "tool_call" || !action.toolName) return null;
  return `${action.toolName}:${stableJson(action.toolInput ?? null)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

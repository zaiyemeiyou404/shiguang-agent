import type { BrainInput, ActionResult } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";
import { inferToolContract } from "../tools/contract.js";

const DEFAULT_MAX_SELECTED_TOOLS = 14;

const CORE_INSPECTION_TOOLS = new Set([
  "inspect_project",
  "list_directory",
  "stat_path",
  "read_text_file",
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
  if (tools.length <= maxSelected) {
    return { selected: tools, total: tools.length, omitted: 0 };
  }

  const text = buildIntentText(input);
  const intent = classifyIntent(text, input.history);
  const recentToolNames = new Set(
    input.history
      .slice(-6)
      .map((result) => result.metadata?.toolName ?? result.action.toolName)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const scored = tools.map((tool, index) => ({
    tool,
    index,
    score: scoreTool(tool, intent, recentToolNames, input.history, text),
  }));

  const selected = ensurePinnedTools(
    scored,
    scored
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, Math.max(1, maxSelected))
      .sort((left, right) => left.index - right.index)
      .map((item) => item.tool),
    pinnedToolsForIntent(intent, text),
    maxSelected,
  );

  return {
    selected,
    total: tools.length,
    omitted: Math.max(0, tools.length - selected.length),
  };
}

function buildIntentText(input: BrainInput): string {
  const userTurn = [...input.context.volatile].reverse().find((item) => item.kind === "user_turn")?.content ?? "";
  const lastSummary = input.workingMemory?.lastObservation?.summary ?? "";
  const lastTool = input.workingMemory?.lastToolName ?? "";
  return `${userTurn}\n${lastSummary}\n${lastTool}`.toLowerCase();
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
  const explicitWebIntent = /网页|联网|上网|网上|网络搜索|网页搜索|搜索网页|搜索网络|联网查|官网|新闻|资料|文档|最新|最近|今天|当前|现在|价格|版本|发布/.test(text);
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
      if (removableIndex >= 0) next.splice(removableIndex, 1);
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
  if (recentToolNames.has(name)) score += 14;
  if (tool.requiresApproval === true && !intent.edit && !intent.execute) score -= 8;

  if (intent.web && (contract.category === "web" || contract.category === "github" || haystack.includes("fetch"))) score += 24;
  if (intent.web && name === "web_search") score += 36;
  if (intent.web && name === "web_fetch" && /url|http|https|网页|链接|抓取|fetch/.test(text)) score += 30;
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
  if (contract.risk !== "read" && !intent.edit && !intent.execute && !intent.validate) score -= 8;
  return score;
}

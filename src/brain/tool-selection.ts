import type { BrainInput, ActionResult } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";

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

  const selected = scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, maxSelected))
    .sort((left, right) => left.index - right.index)
    .map((item) => item.tool);

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
}

function classifyIntent(text: string, history: ActionResult[]): IntentFlags {
  const hadMutation = history.some((result) => result.metadata?.workspaceMutation === true);
  return {
    inspect: /看|查看|分析|理解|梳理|检查|inspect|read|search|find|analy[sz]e|explain|map/.test(text),
    edit: /改|修|写|创建|生成|删除|移动|重命名|保存|fix|edit|write|create|delete|move|rename|patch|implement/.test(text),
    validate: hadMutation || /运行|测试|验证|打包|构建|报错|run|test|typecheck|build|validate|package|error/.test(text),
    web: /网页|联网|搜索网络|github|release|url|http|https|web|fetch|search online|browser/.test(text),
    memory: /记忆|记住|忘记|偏好|memory|remember|forget|preference/.test(text),
    git: /git|提交|差异|diff|status|commit|github|release|仓库/.test(text),
    mcp: /mcp|数据源|database|api|connector|server|tool/.test(text),
    execute: /命令|终端|脚本|执行|启动|install|npm|pnpm|yarn|pip|command|terminal|shell/.test(text),
  };
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
  let score = 0;

  if (CORE_INSPECTION_TOOLS.has(name)) score += intent.inspect || !intent.edit ? 24 : 12;
  if (CORE_EDIT_TOOLS.has(name)) score += intent.edit ? 26 : 3;
  if (CORE_VALIDATE_TOOLS.has(name)) score += intent.validate || intent.execute || intent.git ? 22 : 8;
  if (name === "run_validation" && history.some((result) => result.metadata?.workspaceMutation === true)) score += 20;
  if (recentToolNames.has(name)) score += 14;
  if (tool.requiresApproval === true && !intent.edit && !intent.execute) score -= 8;

  if (intent.web && (haystack.includes("web") || haystack.includes("github") || haystack.includes("fetch"))) score += 24;
  if (intent.memory && haystack.includes("memory")) score += 24;
  if (intent.git && (haystack.includes("git") || haystack.includes("github"))) score += 18;
  if (intent.mcp && (name.startsWith("mcp_") || haystack.includes("mcp."))) score += 18;
  if (intent.execute && haystack.includes("process.")) score += 16;

  const terms = text
    .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
    .filter((term) => term.length >= 3)
    .slice(0, 20);
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  if (name === "echo") score -= 20;
  return score;
}

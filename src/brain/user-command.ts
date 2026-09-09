import type { TaskIntentKind, TaskLoopMode } from "./types.js";

export interface ParsedUserCommand {
  raw: string;
  objective: string;
  normalizedSearchQuery: string;
  explicitUrls: string[];
  toolDirectives: string[];
  skillDirectives: string[];
  outputDirectives: string[];
  constraints: string[];
  modeHint: TaskLoopMode | null;
  taskKind: TaskIntentKind;
  hasExplicitToolRouting: boolean;
  commandContract: UserCommandContract;
}

export interface UserCommandContract {
  version: "shiguang.command.v1";
  original: string;
  objective: string;
  route: TaskLoopMode;
  taskKind: TaskIntentKind;
  targets: {
    urls: string[];
    paths: string[];
  };
  directives: {
    tools: string[];
    skills: string[];
    output: string[];
    constraints: string[];
  };
  immutable: true;
}

const TOOL_ROUTING_RE = /[，,、;；]?\s*(?:并|然后|再|同时)?\s*(?:调用|使用|用|启用|走|通过)\s*(?:这个|该)?\s*(?:skill|工具|tool|插件|能力)?\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s*(?:skill|工具|tool|插件|能力))?/gi;
const EN_TOOL_ROUTING_RE = /[，,、;；]?\s*(?:and\s+)?(?:call|use|invoke|run)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9_-]*)(?:\s+(?:skill|tool|plugin))?/gi;

export function parseUserCommand(message: string): ParsedUserCommand {
  const raw = message.trim();
  const explicitUrls = extractUrls(raw);
  const directiveMatches = [
    ...collectDirectiveMatches(raw, TOOL_ROUTING_RE),
    ...collectDirectiveMatches(raw, EN_TOOL_ROUTING_RE),
  ];
  const toolDirectives = unique(directiveMatches.map((item) => item.name));
  const skillDirectives = toolDirectives.filter((name) => /skill|reader|article|web|mcp|agent|search|fetch/i.test(name));
  const objective = normalizeObjective(removeRanges(raw, directiveMatches.map((item) => [item.start, item.end])));
  const normalizedSearchQuery = cleanSearchQuery(objective || raw);
  const outputDirectives = inferOutputDirectives(raw);
  const constraints = inferConstraints(raw);
  const modeHint = inferModeHint(raw, objective, explicitUrls);
  const taskKind = inferTaskKind(raw, objective, explicitUrls);
  return {
    raw,
    objective: objective || raw,
    normalizedSearchQuery,
    explicitUrls,
    toolDirectives,
    skillDirectives,
    outputDirectives,
    constraints,
    modeHint,
    taskKind,
    hasExplicitToolRouting: toolDirectives.length > 0,
    commandContract: {
      version: "shiguang.command.v1",
      original: raw,
      objective: objective || raw,
      route: modeHint ?? "chat",
      taskKind,
      targets: {
        urls: explicitUrls,
        paths: extractPathHints(objective || raw),
      },
      directives: {
        tools: toolDirectives,
        skills: skillDirectives,
        output: outputDirectives,
        constraints,
      },
      immutable: true,
    },
  };
}

export function cleanSearchQuery(value: string): string {
  const withoutRouting = stripToolRoutingDirectives(value);
  const stripped = withoutRouting
    .replace(/^\s*(?:你能|能不能|可以|帮我|请|麻烦|能)?\s*(?:联网搜索|上网搜索|网上搜索|上网查|查一下|查查|查询|搜索一下|搜一下|搜索|搜|检索|查找|找一下|查)\s*/i, "")
    .replace(/\s*(?:一下|看看|看一下)?\s*(?:吗|嘛|呢)?\s*[？?]?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || withoutRouting.trim() || value.trim();
}

export function stripToolRoutingDirectives(value: string): string {
  return value
    .replace(TOOL_ROUTING_RE, " ")
    .replace(EN_TOOL_ROUTING_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectDirectiveMatches(value: string, pattern: RegExp): Array<{ name: string; start: number; end: number }> {
  const matches: Array<{ name: string; start: number; end: number }> = [];
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(value);
    if (!match) break;
    const name = match[1]?.trim();
    if (!name) continue;
    matches.push({ name, start: match.index, end: match.index + match[0].length });
  }
  pattern.lastIndex = 0;
  return matches;
}

function removeRanges(value: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return value;
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  let cursor = 0;
  let output = "";
  for (const [start, end] of sorted) {
    if (start < cursor) continue;
    output += value.slice(cursor, start);
    cursor = end;
  }
  output += value.slice(cursor);
  return output;
}

function normalizeObjective(value: string): string {
  return value
    .replace(/^[，,、;；\s]+|[，,、;；\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrls(value: string): string[] {
  const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  return unique(urls.map((url) => {
    const cjkIndex = url.search(/[\u4e00-\u9fff]/);
    const withoutTrailingText = cjkIndex > 0 ? url.slice(0, cjkIndex) : url;
    return withoutTrailingText.replace(/[),.;，。！？、]+$/g, "");
  }));
}

function extractPathHints(value: string): string[] {
  const matches = value.match(/[A-Za-z]:[\\/][^\s"'<>，。！？]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/:-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}/g) ?? [];
  return unique(matches.map((item) => item.replace(/[),.;，。！？、]+$/g, "")));
}

function inferOutputDirectives(value: string): string[] {
  const directives: string[] = [];
  if (/markdown|md|表格|列表|分点|摘要|总结|详细|简洁|中文|英文/i.test(value)) {
    directives.push(value.match(/markdown|md|表格|列表|分点|摘要|总结|详细|简洁|中文|英文/i)?.[0] ?? "format");
  }
  return directives;
}

function inferConstraints(value: string): string[] {
  const constraints: string[] = [];
  for (const match of value.matchAll(/(?:不要|别|不能|必须|只要|优先)[^，。；;!?！？]*/g)) {
    constraints.push(match[0].trim());
  }
  return unique(constraints);
}

function inferModeHint(raw: string, objective: string, explicitUrls: string[]): TaskLoopMode | null {
  const text = `${raw}\n${objective}`.toLowerCase();
  const searchIntent = /搜|搜索|查一下|查询|查找|检索|look up|search|find/.test(text);
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory/.test(text);
  const localFileTaskIntent = /翻译|总结|改写|润色|读取|查看|分析|处理|保存|修改|编辑|translate|summari[sz]e|rewrite|polish/.test(text) && localIntent;
  if (
    explicitUrls.length > 0
    || (!localFileTaskIntent && /联网|上网|网上|网页|网址|链接|文章|正文|抓取|官网|新闻|资料|文档|url|github|release|最新|最近|当前|recent|latest|news|online|web/.test(text))
    || (searchIntent && !localIntent)
  ) return "web";
  if (/修|改|写|删|创建|生成|保存|提交|push|commit|build|打包|安装包|release/.test(text)) return "edit";
  if (/验证|测试|运行|报错|error|fail|test|typecheck|lint/.test(text)) return "validation";
  if (localIntent) return "workspace";
  return null;
}

function inferTaskKind(raw: string, objective: string, explicitUrls: string[]): TaskIntentKind {
  const cleanedObjective = objective || stripToolRoutingDirectives(raw) || raw;
  const text = cleanedObjective.toLowerCase();
  const rawText = raw.toLowerCase();
  const hasUrl = explicitUrls.length > 0 || /https?:\/\//.test(rawText);
  const searchIntent = /搜|搜索|查一下|查询|查找|检索|look up|search|find/.test(text);
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory|path|路径/.test(text);
  const fileIntent = /文件|文档|路径|file|readme|\.([a-z0-9]{1,8})(?:\s|$|[，。！？?])/i.test(text);

  if (/release|发布|打包|安装包|推到|上传|github release|tag|版本/.test(text)) return "release";
  if (hasUrl || /正文|文章|网页|网址|链接|抓取|打开|fetch|article|url/.test(text)) return "web_article";
  if (/报错|错误|失败|修复|排查|调试|debug|error|fail|exception|bug/.test(text)) return "debug";
  if (/验证|测试|运行|typecheck|lint|build|test/.test(text)) return "validation";
  if (/修|改|写|删|创建|生成|保存|编辑|patch|write|create|delete|modify|edit/.test(text)) return "edit";

  if (/联网|上网|网上|官网|新闻|资料|最新|最近|当前|online|web|latest|current|news/.test(text) || (searchIntent && !localIntent)) {
    return "web_search";
  }

  if (localIntent && /翻译|总结|改写|润色|提取|整理|translate|summari[sz]e|rewrite|polish|extract/.test(text)) {
    return "file_transform";
  }
  if ((localIntent || fileIntent) && /读取|查看|看一下|打开|分析这个文件|read|view|open/.test(text)) return "file_read";
  if (/代码|工程|项目|架构|模块|依赖|函数|类|接口|仓库|codebase|architecture|module|dependency|symbol/.test(text)) {
    return "code_analysis";
  }
  if (localIntent) return "workspace_overview";
  return "chat";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

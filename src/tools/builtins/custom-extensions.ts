import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tool, ToolApprovalPreview } from "../types.js";

const EXTENSION_VERSION = "shiguang.extension.v1" as const;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_TOOL_BYTES = 64 * 1024;
const MAX_TEMPLATE_CHARS = 16_000;
const SKILL_CONTRACT_VERSION = "shiguang.skill.v1" as const;

type SkillLayer = "global" | "domain" | "project" | "session" | "task";

interface CreateCustomSkillInput {
  name: string;
  description?: string;
  instructions: string;
  enabled?: boolean;
  layer?: SkillLayer;
  scope?: string;
  triggers?: string[];
  priority?: number;
  version?: number;
}

interface CreateCustomToolInput {
  name: string;
  description: string;
  template: string;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
}

interface RunCustomToolInput {
  name: string;
  input?: Record<string, unknown>;
}

interface RecordAgentRuleInput {
  scope: string;
  rule: string;
  evidence?: string;
  enabled?: boolean;
}

export interface CustomSkill {
  name: string;
  description?: string;
  enabled: boolean;
  path: string;
  instructions: string;
  contract: typeof SKILL_CONTRACT_VERSION;
  layer: SkillLayer;
  scope?: string;
  triggers: string[];
  priority: number;
  version: number;
}

export interface CustomToolManifest {
  version: typeof EXTENSION_VERSION;
  name: string;
  description: string;
  kind: "template";
  inputSchema: Record<string, unknown>;
  template: string;
  enabled: boolean;
}

export interface CustomSkillSelectionContext {
  userMessage?: string;
  availableTools?: Array<string | { name: string }>;
  workspaceRoot?: string;
  maxSkills?: number;
}

interface ExtensionRoots {
  root: string;
  skillsDir: string;
  toolsDir: string;
}

function extensionRoots(extensionRoot: string): ExtensionRoots {
  const root = resolve(extensionRoot);
  return {
    root,
    skillsDir: join(root, "skills"),
    toolsDir: join(root, "tools"),
  };
}

function ensureExtensionDirs(extensionRoot: string): ExtensionRoots {
  const roots = extensionRoots(extensionRoot);
  mkdirSync(roots.skillsDir, { recursive: true });
  mkdirSync(roots.toolsDir, { recursive: true });
  return roots;
}

function safeExtensionName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!normalized) {
    throw new Error("custom extension name must contain letters or numbers");
  }
  return normalized;
}

function customToolName(value: string): string {
  const safe = safeExtensionName(value);
  return safe.startsWith("custom_") ? safe : `custom_${safe}`;
}

function assertInside(parent: string, child: string): void {
  const resolvedParent = resolve(parent).toLowerCase();
  const resolvedChild = resolve(child).toLowerCase();
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(`${resolvedParent}\\`) && !resolvedChild.startsWith(`${resolvedParent}/`)) {
    throw new Error("custom extension path must stay inside the extension directory");
  }
}

function parseSkillMarkdown(content: string, path: string, fallbackName: string): CustomSkill {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = match ? parseFrontmatter(match[1] ?? "") : {};
  const body = match ? match[2] ?? "" : normalized;
  return {
    name: readString(frontmatter.name) ?? fallbackName,
    ...(readString(frontmatter.description) ? { description: readString(frontmatter.description) } : {}),
    enabled: readBoolean(frontmatter.enabled, true),
    path,
    instructions: body.trim(),
    contract: SKILL_CONTRACT_VERSION,
    layer: readSkillLayer(frontmatter.layer),
    ...(readString(frontmatter.scope) ? { scope: readString(frontmatter.scope) } : {}),
    triggers: readStringList(frontmatter.triggers),
    priority: readInteger(frontmatter.priority, defaultSkillPriority(readSkillLayer(frontmatter.layer))),
    version: readInteger(frontmatter.version, 1),
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    out[match[1] ?? ""] = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  return fallback;
}

function readInteger(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStringList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function readSkillLayer(value: unknown): SkillLayer {
  if (typeof value !== "string") return "global";
  const normalized = value.trim().toLowerCase();
  if (normalized === "domain" || normalized === "project" || normalized === "session" || normalized === "task") return normalized;
  return "global";
}

function serializeSkillLayer(value: SkillLayer | undefined): SkillLayer {
  return value ?? "global";
}

function defaultSkillPriority(layer: SkillLayer): number {
  switch (layer) {
    case "task": return 90;
    case "session": return 80;
    case "project": return 70;
    case "domain": return 60;
    case "global": return 50;
  }
}

function renderSkillMarkdown(input: CreateCustomSkillInput, safeName: string): string {
  const description = input.description?.trim() ?? "";
  const layer = serializeSkillLayer(input.layer);
  const priority = typeof input.priority === "number" ? Math.trunc(input.priority) : defaultSkillPriority(layer);
  return [
    "---",
    `name: ${safeName}`,
    description ? `description: ${description}` : null,
    `enabled: ${input.enabled === false ? "false" : "true"}`,
    `contract: ${SKILL_CONTRACT_VERSION}`,
    `layer: ${layer}`,
    input.scope?.trim() ? `scope: ${input.scope.trim()}` : null,
    input.triggers && input.triggers.length > 0 ? `triggers: ${input.triggers.map((trigger) => trigger.trim()).filter(Boolean).join(", ")}` : null,
    `priority: ${priority}`,
    `version: ${typeof input.version === "number" ? Math.max(1, Math.trunc(input.version)) : 1}`,
    "---",
    "",
    input.instructions.trim(),
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

const DEFAULT_CUSTOM_SKILLS: CreateCustomSkillInput[] = [
  {
    name: "web_article_reader",
    description: "Fetch explicit URLs and extract the real article body before answering.",
    enabled: true,
    layer: "domain",
    scope: "web_fetch",
    triggers: [
      "http",
      "https",
      "url",
      "link",
      "webpage",
      "article",
      "news",
      "body",
      "网页",
      "网址",
      "链接",
      "文章",
      "新闻",
      "正文",
      "抓取",
    ],
    priority: 85,
    version: 1,
    instructions: [
      "# Web Article Reader",
      "",
      "Use this skill when the latest user message asks to read, inspect, summarize, or explain a web page, article, news page, blog post, announcement, or an explicit http/https URL.",
      "",
      "## Routing",
      "",
      "1. If the latest user message contains an explicit http:// or https:// URL, call web_fetch on that exact URL first.",
      "2. Do not search the URL string first, and do not continue an unrelated local workspace task from older conversation history.",
      "3. Use web_search only when there is no explicit URL, direct fetch fails, the fetched content is incomplete, or cross-checking is necessary.",
      "4. After web_search, fetch the most relevant original source page before giving a content answer; do not answer from snippets alone.",
      "",
      "## Article Body Selection",
      "",
      "1. Prefer articleCandidates or structured article text that matches the page title, author/date area, and topic keywords.",
      "2. Prefer sources in this order: JSON-LD articleBody, article/main content containers, dense contiguous paragraph clusters, then whole-page text as a fallback.",
      "3. Exclude navigation, login/register prompts, download/app banners, QR-code sections, copyright footers, comments, related links, ads, and duplicated boilerplate.",
      "4. Do not choose the longest candidate by length alone. Choose the candidate that continues the title/topic coherently with the least boilerplate.",
      "",
      "## Answering",
      "",
      "1. Complete the user's requested reading, extraction, explanation, or summary directly from the fetched page.",
      "2. Preserve key names, numbers, dates, places, and claims. Mark inference clearly if you infer beyond the text.",
      "3. Include the source URL. If extraction is incomplete, say what was captured, what is missing, and why.",
      "4. When the user only says 'look at this', briefly state the page topic, core content, and notable details. Do not only repeat tool output.",
      "",
      "## Stop Condition",
      "",
      "Stop once a credible article body has been found and the user's question has been answered. Do not keep reading local files, modifying projects, or searching unrelated topics.",
    ].join("\n"),
  },
];

export function ensureDefaultCustomSkills(extensionRoot: string): string[] {
  const roots = ensureExtensionDirs(extensionRoot);
  const created: string[] = [];
  for (const skill of DEFAULT_CUSTOM_SKILLS) {
    const safeName = safeExtensionName(skill.name);
    const path = skillPath(extensionRoot, safeName);
    if (existsSync(path)) continue;
    writeFileSync(path, renderSkillMarkdown(skill, safeName), "utf8");
    created.push(path);
  }
  return created;
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", additionalProperties: true };
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== "object") {
    return { type: "object", additionalProperties: true };
  }
  return schema;
}

function parseCreateSkillInput(input: unknown): CreateCustomSkillInput {
  if (!input || typeof input !== "object") {
    throw new Error("create_custom_skill: input must be { name, instructions, description?, enabled? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name.trim()) throw new Error("create_custom_skill: name is required");
  if (typeof obj.instructions !== "string" || !obj.instructions.trim()) throw new Error("create_custom_skill: instructions is required");
  return {
    name: obj.name,
    instructions: obj.instructions.slice(0, MAX_SKILL_BYTES),
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.enabled === "boolean" ? { enabled: obj.enabled } : {}),
    ...(typeof obj.layer === "string" ? { layer: readSkillLayer(obj.layer) } : {}),
    ...(typeof obj.scope === "string" ? { scope: obj.scope } : {}),
    ...(Array.isArray(obj.triggers) ? { triggers: obj.triggers.filter((item): item is string => typeof item === "string").slice(0, 24) } : {}),
    ...(typeof obj.priority === "number" ? { priority: obj.priority } : {}),
    ...(typeof obj.version === "number" ? { version: obj.version } : {}),
  };
}

function parseCreateToolInput(input: unknown): CreateCustomToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("create_custom_tool: input must be { name, description, template, inputSchema?, enabled? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name.trim()) throw new Error("create_custom_tool: name is required");
  if (typeof obj.description !== "string" || !obj.description.trim()) throw new Error("create_custom_tool: description is required");
  if (typeof obj.template !== "string" || !obj.template.trim()) throw new Error("create_custom_tool: template is required");
  return {
    name: obj.name,
    description: obj.description,
    template: obj.template.slice(0, MAX_TEMPLATE_CHARS),
    inputSchema: normalizeInputSchema(obj.inputSchema),
    ...(typeof obj.enabled === "boolean" ? { enabled: obj.enabled } : {}),
  };
}

function parseRunCustomToolInput(input: unknown): RunCustomToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("run_custom_tool: input must be { name, input? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name.trim()) throw new Error("run_custom_tool: name is required");
  return {
    name: obj.name,
    input: obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)
      ? obj.input as Record<string, unknown>
      : {},
  };
}

function parseRecordAgentRuleInput(input: unknown): RecordAgentRuleInput {
  if (!input || typeof input !== "object") {
    throw new Error("record_agent_rule: input must be { scope, rule, evidence?, enabled? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.scope !== "string" || !obj.scope.trim()) throw new Error("record_agent_rule: scope is required");
  if (typeof obj.rule !== "string" || !obj.rule.trim()) throw new Error("record_agent_rule: rule is required");
  return {
    scope: obj.scope.slice(0, 160),
    rule: obj.rule.slice(0, 2_000),
    ...(typeof obj.evidence === "string" ? { evidence: obj.evidence.slice(0, 1_000) } : {}),
    ...(typeof obj.enabled === "boolean" ? { enabled: obj.enabled } : {}),
  };
}

function readToolManifest(path: string): CustomToolManifest | null {
  if (!existsSync(path)) return null;
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_TOOL_BYTES) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CustomToolManifest>;
  if (parsed.version !== EXTENSION_VERSION) return null;
  if (parsed.kind !== "template") return null;
  if (typeof parsed.name !== "string" || typeof parsed.description !== "string" || typeof parsed.template !== "string") return null;
  return {
    version: EXTENSION_VERSION,
    name: customToolName(parsed.name),
    description: parsed.description,
    kind: "template",
    inputSchema: normalizeInputSchema(parsed.inputSchema),
    template: parsed.template,
    enabled: parsed.enabled !== false,
  };
}

function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = readPath(input, key);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

function readPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function manifestPath(extensionRoot: string, name: string): string {
  const roots = ensureExtensionDirs(extensionRoot);
  const path = join(roots.toolsDir, `${customToolName(name)}.json`);
  assertInside(roots.toolsDir, path);
  return path;
}

function skillPath(extensionRoot: string, name: string): string {
  const roots = ensureExtensionDirs(extensionRoot);
  const path = join(roots.skillsDir, `${safeExtensionName(name)}.md`);
  assertInside(roots.skillsDir, path);
  return path;
}

function agentRulesPath(extensionRoot: string): string {
  return skillPath(extensionRoot, "agent_rules");
}

export function loadCustomSkills(extensionRoot: string): CustomSkill[] {
  const roots = ensureExtensionDirs(extensionRoot);
  return readdirSync(roots.skillsDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => {
      const path = join(roots.skillsDir, entry);
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_SKILL_BYTES) return null;
      return parseSkillMarkdown(readFileSync(path, "utf8"), path, entry.replace(/\.md$/i, ""));
    })
    .filter((skill): skill is CustomSkill => Boolean(skill));
}

export function loadCustomToolManifests(extensionRoot: string): CustomToolManifest[] {
  const roots = ensureExtensionDirs(extensionRoot);
  return readdirSync(roots.toolsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => readToolManifest(join(roots.toolsDir, entry)))
    .filter((tool): tool is CustomToolManifest => Boolean(tool));
}

function normalizeAvailableToolNames(tools: CustomSkillSelectionContext["availableTools"]): Set<string> {
  return new Set((tools ?? []).map((tool) => typeof tool === "string" ? tool : tool.name).filter(Boolean));
}

function scoreCustomSkill(skill: CustomSkill, context?: CustomSkillSelectionContext): number {
  if (!skill.enabled || !skill.instructions.trim()) return Number.NEGATIVE_INFINITY;
  const text = [
    context?.userMessage ?? "",
    context?.workspaceRoot ?? "",
  ].join("\n").toLowerCase();
  const availableTools = normalizeAvailableToolNames(context?.availableTools);
  let score = skill.priority;

  if (skill.layer === "global") score += 8;
  if (skill.layer === "domain") score += 16;
  if (skill.layer === "project" && context?.workspaceRoot) score += 18;
  if (skill.layer === "session") score += 12;
  if (skill.layer === "task") score += 20;

  const haystack = `${text}\n${Array.from(availableTools).join("\n").toLowerCase()}`;
  const triggers = skill.triggers.map((trigger) => trigger.toLowerCase()).filter(Boolean);
  if (triggers.length > 0) {
    const matches = triggers.filter((trigger) => haystack.includes(trigger));
    if (matches.length === 0 && skill.layer !== "global") return Number.NEGATIVE_INFINITY;
    score += matches.length * 28;
  }

  if (skill.scope && availableTools.has(skill.scope)) score += 35;
  if (skill.scope && haystack.includes(skill.scope.toLowerCase())) score += 24;
  return score;
}

export function selectCustomSkills(skills: CustomSkill[], context?: CustomSkillSelectionContext): CustomSkill[] {
  const maxSkills = Math.max(1, Math.min(context?.maxSkills ?? 6, 12));
  return skills
    .map((skill) => ({ skill, score: scoreCustomSkill(skill, context) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, maxSkills)
    .map((item) => item.skill);
}

export function formatCustomSkillInstructions(skills: CustomSkill[], context?: CustomSkillSelectionContext): string | null {
  const enabled = selectCustomSkills(skills, context);
  if (enabled.length === 0) return null;
  return [
    "Relevant Shiguang skills are active.",
    "These are selected user/Agent-authored reusable instructions. Follow them when relevant, but the latest user message remains authoritative.",
    "Skill contract: shiguang.skill.v1. Layers: global < domain < project < session < task. Higher priority and trigger matches are injected first.",
    "",
    ...enabled.map((skill) => [
      `Skill: ${skill.name}`,
      `Layer: ${skill.layer}`,
      skill.scope ? `Scope: ${skill.scope}` : null,
      skill.triggers.length > 0 ? `Triggers: ${skill.triggers.join(", ")}` : null,
      `Priority: ${skill.priority}`,
      skill.description ? `Description: ${skill.description}` : null,
      `Source: ${skill.path}`,
      skill.instructions,
    ].filter((line): line is string => line !== null).join("\n")),
  ].join("\n\n");
}

export function createCustomExtensionTools(extensionRoot: string): Tool[] {
  return [
    createListCustomExtensionsTool(extensionRoot),
    createRecordAgentRuleTool(extensionRoot),
    createCreateCustomSkillTool(extensionRoot),
    createCreateCustomToolTool(extensionRoot),
    createRunCustomToolTool(extensionRoot),
  ];
}

export function loadCustomExtensionTools(extensionRoot: string): Tool[] {
  return loadCustomToolManifests(extensionRoot)
    .filter((manifest) => manifest.enabled)
    .map((manifest) => createCustomTemplateTool(manifest));
}

export function createListCustomExtensionsTool(extensionRoot: string): Tool {
  return {
    descriptor: {
      name: "list_custom_extensions",
      description: "List user-created Shiguang skills and custom declarative tools.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      requiresApproval: false,
      capability: "extensions.list",
    },
    async execute(): Promise<unknown> {
      const roots = ensureExtensionDirs(extensionRoot);
      return {
        root: roots.root,
        skills: loadCustomSkills(extensionRoot).map(({ instructions, ...skill }) => ({
          ...skill,
          instructionChars: instructions.length,
        })),
        tools: loadCustomToolManifests(extensionRoot).map(({ template, ...tool }) => ({
          ...tool,
          templateChars: template.length,
        })),
      };
    },
  };
}

export function createRecordAgentRuleTool(extensionRoot: string): Tool {
  return {
    descriptor: {
      name: "record_agent_rule",
      description: "Append a reusable approved operating rule to Shiguang's agent_rules skill. Use this for durable lessons such as site extraction patterns, tool-routing rules, or project workflow habits.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Short area this rule applies to, for example web_fetch, workspace, approvals, or a domain name." },
          rule: { type: "string", description: "Reusable rule written as an instruction for future runs." },
          evidence: { type: "string", description: "Optional short note explaining what observation led to this rule." },
          enabled: { type: "boolean" },
        },
        required: ["scope", "rule"],
      },
      risk: "write",
      requiresApproval: true,
      capability: "extensions.rule.write",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const parsed = parseRecordAgentRuleInput(input);
      return {
        kind: "summary",
        title: `记录 Agent 规则：${parsed.scope.trim()}`,
        path: agentRulesPath(extensionRoot),
        operation: "record_agent_rule",
        warnings: ["这条规则会进入后续运行的提示词。请只保留可复用经验，不要写一次性任务内容、密钥或私人信息。"],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      const parsed = parseRecordAgentRuleInput(input);
      const path = agentRulesPath(extensionRoot);
      const header = renderSkillMarkdown({
        name: "agent_rules",
        description: "Agent-authored adaptive operating rules",
        instructions: [
          "# Agent Rules",
          "",
          "These durable rules were written by Shiguang after user approval. Apply them when relevant; the latest user message remains authoritative.",
          "",
        ].join("\n"),
        enabled: parsed.enabled !== false,
      }, "agent_rules");
      const existing = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : header.trimEnd();
      const entry = [
        "",
        `## ${parsed.scope.trim()}`,
        "",
        `- Rule: ${parsed.rule.trim()}`,
        ...(parsed.evidence?.trim() ? [`- Evidence: ${parsed.evidence.trim()}`] : []),
        `- Recorded: ${new Date().toISOString()}`,
        "",
      ].join("\n");
      writeFileSync(path, `${existing}${entry}`, "utf8");
      return {
        name: "agent_rules",
        path,
        scope: parsed.scope.trim(),
        status: "recorded",
      };
    },
  };
}

export function createCreateCustomSkillTool(extensionRoot: string): Tool {
  return {
    descriptor: {
      name: "create_custom_skill",
      description: "Create or overwrite a reusable Shiguang skill markdown file. The skill is injected into future agent prompts when enabled.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
          enabled: { type: "boolean" },
          layer: { type: "string", enum: ["global", "domain", "project", "session", "task"] },
          scope: { type: "string" },
          triggers: { type: "array", items: { type: "string" } },
          priority: { type: "number" },
          version: { type: "number" },
        },
        required: ["name", "instructions"],
      },
      risk: "write",
      requiresApproval: true,
      capability: "extensions.skill.write",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const parsed = parseCreateSkillInput(input);
      return {
        kind: "summary",
        title: `创建自定义 skill：${safeExtensionName(parsed.name)}`,
        path: skillPath(extensionRoot, parsed.name),
        operation: "create_custom_skill",
        warnings: ["这个 skill 会在后续运行中注入提示词，建议只写可复用规则，不要写一次性任务。"],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      const parsed = parseCreateSkillInput(input);
      const safeName = safeExtensionName(parsed.name);
      const path = skillPath(extensionRoot, safeName);
      writeFileSync(path, renderSkillMarkdown(parsed, safeName), "utf8");
      return { name: safeName, path, enabled: parsed.enabled !== false, status: "created" };
    },
  };
}

export function createCreateCustomToolTool(extensionRoot: string): Tool {
  return {
    descriptor: {
      name: "create_custom_tool",
      description: "Create or overwrite a declarative template tool. Template variables use {{name}} placeholders and can be executed by run_custom_tool or as a loaded custom_* tool in future runs.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          template: { type: "string" },
          inputSchema: { type: "object" },
          enabled: { type: "boolean" },
        },
        required: ["name", "description", "template"],
      },
      risk: "write",
      requiresApproval: true,
      capability: "extensions.tool.write",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const parsed = parseCreateToolInput(input);
      return {
        kind: "summary",
        title: `创建自定义工具：${customToolName(parsed.name)}`,
        path: manifestPath(extensionRoot, parsed.name),
        operation: "create_custom_tool",
        warnings: ["第一版自定义工具只支持声明式模板，不会执行任意 JS/命令。"],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      const parsed = parseCreateToolInput(input);
      const name = customToolName(parsed.name);
      const manifest: CustomToolManifest = {
        version: EXTENSION_VERSION,
        name,
        description: parsed.description.trim(),
        kind: "template",
        inputSchema: parsed.inputSchema ?? { type: "object", additionalProperties: true },
        template: parsed.template.trim(),
        enabled: parsed.enabled !== false,
      };
      const path = manifestPath(extensionRoot, name);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return { name, path, enabled: manifest.enabled, status: "created" };
    },
  };
}

export function createRunCustomToolTool(extensionRoot: string): Tool {
  return {
    descriptor: {
      name: "run_custom_tool",
      description: "Run an enabled user-created declarative custom tool by name. Accepts { name, input? }.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          input: { type: "object" },
        },
        required: ["name"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "extensions.tool.run",
    },
    async execute(input: unknown): Promise<unknown> {
      const parsed = parseRunCustomToolInput(input);
      const name = customToolName(parsed.name);
      const manifest = loadCustomToolManifests(extensionRoot).find((tool) => tool.name === name);
      if (!manifest || !manifest.enabled) {
        throw new Error(`run_custom_tool: enabled custom tool not found: ${name}`);
      }
      return runTemplateManifest(manifest, parsed.input ?? {});
    },
  };
}

function createCustomTemplateTool(manifest: CustomToolManifest): Tool {
  return {
    descriptor: {
      name: manifest.name,
      description: `[Custom tool] ${manifest.description}`,
      inputSchema: manifest.inputSchema,
      risk: "read",
      requiresApproval: false,
      capability: "extensions.custom.template",
    },
    async execute(input: unknown): Promise<unknown> {
      const values = input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      return runTemplateManifest(manifest, values);
    },
  };
}

function runTemplateManifest(manifest: CustomToolManifest, input: Record<string, unknown>): unknown {
  return {
    tool: manifest.name,
    kind: manifest.kind,
    output: renderTemplate(manifest.template, input),
  };
}

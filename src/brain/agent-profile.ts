import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ToolDescriptor } from "../tools/types.js";

export interface AgentProfile {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  sourcePath: string;
  instructions: string;
}

export interface AgentProfileLoadOptions {
  profileName?: string;
}

const DEFAULT_PROFILE_NAME = "default";
const MAX_PROFILE_BYTES = 64 * 1024;

export function loadProjectAgentProfile(
  workspaceRoot: string,
  options: AgentProfileLoadOptions = {},
): AgentProfile | null {
  const root = resolve(workspaceRoot);
  const profileName = normalizeProfileName(options.profileName ?? process.env.SHIGUANG_AGENT_PROFILE);
  const candidates = profileCandidates(root, profileName);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stats = statSync(candidate);
    if (!stats.isFile() || stats.size > MAX_PROFILE_BYTES) continue;
    const content = readFileSync(candidate, "utf8");
    return parseAgentProfile(content, candidate, profileName);
  }

  return null;
}

export function parseAgentProfile(
  content: string,
  sourcePath = ".shiguang/agents/default.md",
  fallbackName = DEFAULT_PROFILE_NAME,
): AgentProfile {
  const parsed = splitFrontmatter(content);
  const frontmatter = parseSimpleFrontmatter(parsed.frontmatter);
  const sourceName = basename(sourcePath).replace(/\.[^.]+$/, "");
  const name = normalizeProfileName(readString(frontmatter.name) ?? fallbackName ?? sourceName) || DEFAULT_PROFILE_NAME;

  return {
    name,
    ...(readString(frontmatter.description) ? { description: readString(frontmatter.description) } : {}),
    ...(readString(frontmatter.model) ? { model: readString(frontmatter.model) } : {}),
    ...(readString(frontmatter.thinking) ? { thinking: readString(frontmatter.thinking) } : {}),
    ...(readStringArray(frontmatter.tools) ? { tools: readStringArray(frontmatter.tools) } : {}),
    sourcePath,
    instructions: parsed.body.trim(),
  };
}

export function applyAgentProfileToolAllowlist(
  tools: ToolDescriptor[],
  profile: AgentProfile | null,
): ToolDescriptor[] {
  const allowlist = profile?.tools;
  if (!allowlist || allowlist.length === 0) return tools;
  const allowed = new Set(allowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}

export function formatAgentProfileInstructions(profile: AgentProfile | null): string | null {
  if (!profile) return null;
  const lines = [
    "Project agent profile is active.",
    `- Profile: ${profile.name}`,
    profile.description ? `- Description: ${profile.description}` : null,
    profile.model ? `- Preferred model: ${profile.model}` : null,
    profile.thinking ? `- Thinking level: ${profile.thinking}` : null,
    profile.tools?.length ? `- Tool allowlist: ${profile.tools.join(", ")}` : null,
    `- Source: ${profile.sourcePath}`,
    "",
    "Profile instructions:",
    profile.instructions || "(No extra instructions.)",
    "",
    "Follow this project-local profile unless the user's current request explicitly overrides it.",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function listProjectAgentProfiles(workspaceRoot: string): AgentProfile[] {
  const agentsDir = join(resolve(workspaceRoot), ".shiguang", "agents");
  if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) return [];
  return readdirSync(agentsDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(agentsDir, entry))
    .filter((path) => statSync(path).isFile())
    .map((path) => parseAgentProfile(readFileSync(path, "utf8"), path, basename(path).replace(/\.md$/, "")));
}

function profileCandidates(workspaceRoot: string, profileName: string): string[] {
  const safeName = normalizeProfileName(profileName) || DEFAULT_PROFILE_NAME;
  const agentsDir = join(workspaceRoot, ".shiguang", "agents");
  const candidates = [
    join(agentsDir, `${safeName}.md`),
  ];
  if (safeName !== DEFAULT_PROFILE_NAME) {
    candidates.push(join(agentsDir, `${DEFAULT_PROFILE_NAME}.md`));
  }
  candidates.push(join(workspaceRoot, ".shiguang", "agent.md"));
  return unique(candidates);
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { frontmatter: "", body: normalized };
  }

  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: normalized };
  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? "",
  };
}

function parseSimpleFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (currentArrayKey && trimmed.startsWith("- ")) {
      const next = String(trimmed.slice(2).trim()).replace(/^["']|["']$/g, "");
      const current = Array.isArray(out[currentArrayKey]) ? out[currentArrayKey] as string[] : [];
      out[currentArrayKey] = [...current, next].filter(Boolean);
      continue;
    }

    currentArrayKey = null;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (!key) continue;
    if (!value) {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }
    out[key] = parseFrontmatterValue(value);
  }

  return out;
}

function parseFrontmatterValue(value: string): unknown {
  const unquoted = value.replace(/^["']|["']$/g, "");
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return unquoted;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return items.length > 0 ? unique(items) : undefined;
}

function normalizeProfileName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROFILE_NAME;
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  return normalized || DEFAULT_PROFILE_NAME;
}

function unique<T>(items: T[]): T[] {
  return items.filter((item, index) => items.indexOf(item) === index);
}

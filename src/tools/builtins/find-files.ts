import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toPortablePath } from "./path-format.js";

const DEFAULT_MAX_RESULTS = 40;
const HARD_MAX_RESULTS = 120;
const MAX_DEPTH = 10;
const MAX_SCANNED = 12_000;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", "desktop-build", ".codegraph", ".tmp", "ui/dist"]);

export interface FindFilesInput {
  query?: string;
  pattern?: string;
  path?: string;
  includeDirectories?: boolean;
  maxResults?: number;
}

export interface FindFileResult {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedMs: number;
  score: number;
}

export interface FindFilesOutput {
  query: string;
  root: string;
  results: FindFileResult[];
  scanned: number;
  truncated: boolean;
  hint: string;
}

function parseInput(input: unknown): FindFilesInput {
  if (typeof input === "string") return { query: input };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("find_files: input must be a query string or { query?, pattern?, path? }");
  }
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.includeDirectories === "boolean" ? { includeDirectories: record.includeDirectories } : {}),
    ...(typeof record.maxResults === "number" ? { maxResults: record.maxResults } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function clampMaxResults(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(HARD_MAX_RESULTS, Math.trunc(value ?? DEFAULT_MAX_RESULTS)));
}

function globToRegex(pattern: string): RegExp | null {
  if (!/[*?]/.test(pattern)) return null;
  const normalized = toPortablePath(pattern).replace(/^\.\//, "");
  let escaped = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      escaped += ".*";
      index += 1;
    } else if (char === "*") {
      escaped += "[^/]*";
    } else if (char === "?") {
      escaped += "[^/]";
    } else {
      escaped += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`(^|/)${escaped}$`, "i");
}

function scoreResult(relPath: string, name: string, query: string, patternRegex: RegExp | null): number {
  const normalizedPath = relPath.toLowerCase();
  const normalizedName = name.toLowerCase();
  const normalizedQuery = query.toLowerCase().replace(/^\.\//, "");
  if (patternRegex?.test(relPath)) return 100;
  if (normalizedName === normalizedQuery) return 90;
  if (normalizedPath === normalizedQuery) return 88;
  if (normalizedName.startsWith(normalizedQuery)) return 72;
  if (normalizedName.includes(normalizedQuery)) return 60;
  if (normalizedPath.includes(normalizedQuery)) return 45;
  if (normalizedQuery.startsWith(".") && extname(normalizedName) === normalizedQuery) return 68;
  return 0;
}

function walk(
  dirPath: string,
  workspaceRoot: string,
  query: string,
  patternRegex: RegExp | null,
  includeDirectories: boolean,
  maxResults: number,
  context: ToolExecutionContext | undefined,
  state: { results: FindFileResult[]; scanned: number; truncated: boolean },
  depth = 0,
): void {
  throwIfAborted(context?.signal);
  if (depth > MAX_DEPTH || state.scanned >= MAX_SCANNED || state.results.length >= maxResults) {
    state.truncated = true;
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    throwIfAborted(context?.signal);
    if (state.results.length >= maxResults || state.scanned >= MAX_SCANNED) {
      state.truncated = true;
      return;
    }

    const fullPath = join(dirPath, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    const relPath = toPortablePath(relative(workspaceRoot, fullPath) || basename(fullPath));
    const isDirectory = stats.isDirectory();
    state.scanned += 1;

    if (isDirectory && SKIP_DIRS.has(entry)) continue;

    if (!isDirectory || includeDirectories) {
      const score = scoreResult(relPath, entry, query, patternRegex);
      if (score > 0) {
        state.results.push({
          name: entry,
          path: relPath,
          kind: isDirectory ? "directory" : "file",
          size: stats.size,
          modifiedMs: stats.mtimeMs,
          score,
        });
      }
    }

    if (isDirectory) {
      walk(fullPath, workspaceRoot, query, patternRegex, includeDirectories, maxResults, context, state, depth + 1);
    }
  }
}

export function createFindFilesTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "find_files",
      description: "Find workspace files or directories by filename, extension, or glob-like pattern. Use when a requested path/name is unclear before reading files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filename, extension, path fragment, or simple glob to find." },
          pattern: { type: "string", description: "Optional glob-like pattern such as *.ts, README*, src/**/*.tsx." },
          path: { type: "string", description: "Optional workspace subdirectory to search from. Default workspace root." },
          includeDirectories: { type: "boolean", description: "Whether directory matches should be returned. Default false." },
          maxResults: { type: "number", description: "Maximum results. Default 40, hard max 120." },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.find",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<FindFilesOutput> {
      throwIfAborted(context?.signal);
      const parsed = parseInput(input);
      const query = (parsed.pattern ?? parsed.query ?? "").trim();
      if (!query) {
        throw new Error("find_files: provide query or pattern");
      }
      const searchRoot = resolveWorkspacePath(workspaceRoot, parsed.path ?? ".");
      const maxResults = clampMaxResults(parsed.maxResults);
      const state = { results: [] as FindFileResult[], scanned: 0, truncated: false };
      walk(searchRoot, workspaceRoot, query, globToRegex(query), parsed.includeDirectories === true, maxResults, context, state);
      const results = state.results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
      return {
        query,
        root: toPortablePath(relative(workspaceRoot, searchRoot) || "."),
        results,
        scanned: state.scanned,
        truncated: state.truncated,
        hint: results.length > 0
          ? "Use read_text_file or read_many_files on the relevant result paths before answering or editing."
          : "No matching files found; try a broader name fragment or list_directory on a nearby parent.",
      };
    },
  };
}

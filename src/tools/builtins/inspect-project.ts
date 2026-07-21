import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { toPortablePath } from "./path-format.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", "desktop-build", ".tmp", "coverage", ".vite"]);
const MAX_SCAN_FILES = 2_000;

export interface InspectProjectOutput {
  workspaceRoot: string;
  package: {
    name: string | null;
    version: string | null;
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
  } | null;
  topLevelEntries: Array<{ path: string; kind: "file" | "directory" }>;
  fileStats: {
    filesScanned: number;
    byExtension: Record<string, number>;
    truncated: boolean;
  };
  detected: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function readPackage(workspaceRoot: string): InspectProjectOutput["package"] {
  const packagePath = join(workspaceRoot, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const dependencies = parsed.dependencies && typeof parsed.dependencies === "object" && !Array.isArray(parsed.dependencies)
      ? Object.keys(parsed.dependencies)
      : [];
    const devDependencies = parsed.devDependencies && typeof parsed.devDependencies === "object" && !Array.isArray(parsed.devDependencies)
      ? Object.keys(parsed.devDependencies)
      : [];
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      scripts,
      dependencies,
      devDependencies,
    };
  } catch {
    return null;
  }
}

function scanFiles(dirPath: string, workspaceRoot: string, stats: InspectProjectOutput["fileStats"], depth = 0): void {
  if (stats.filesScanned >= MAX_SCAN_FILES || depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (stats.filesScanned >= MAX_SCAN_FILES) {
      stats.truncated = true;
      return;
    }
    const fullPath = join(dirPath, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        scanFiles(fullPath, workspaceRoot, stats, depth + 1);
      }
      continue;
    }
    if (!stat.isFile()) continue;
    stats.filesScanned += 1;
    const ext = extname(entry).toLowerCase() || "[no-ext]";
    stats.byExtension[ext] = (stats.byExtension[ext] ?? 0) + 1;
  }
}

function detectProject(pkg: InspectProjectOutput["package"], topLevelNames: Set<string>): string[] {
  const deps = new Set([...(pkg?.dependencies ?? []), ...(pkg?.devDependencies ?? [])]);
  const detected: string[] = [];
  if (deps.has("electron")) detected.push("electron");
  if (deps.has("react")) detected.push("react");
  if (deps.has("vite") || topLevelNames.has("vite.config.ts")) detected.push("vite");
  if (deps.has("typescript") || topLevelNames.has("tsconfig.json")) detected.push("typescript");
  if (topLevelNames.has("package-lock.json")) detected.push("npm");
  if (topLevelNames.has(".github")) detected.push("github-actions");
  return detected;
}

export function createInspectProjectTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "inspect_project",
      description: "Summarize project shape, package scripts, top-level files, and lightweight file statistics. Use at the start of unfamiliar project work.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      risk: "read",
      requiresApproval: false,
      capability: "project.inspect",
    },
    async execute(_input: unknown, context?: ToolExecutionContext): Promise<InspectProjectOutput> {
      throwIfAborted(context?.signal);
      const entries = readdirSync(workspaceRoot, { withFileTypes: true });
      const topLevelEntries = entries
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .slice(0, 80)
        .map((entry) => ({
          path: toPortablePath(relative(workspaceRoot, join(workspaceRoot, entry.name))),
          kind: entry.isDirectory() ? "directory" as const : "file" as const,
        }));
      const fileStats: InspectProjectOutput["fileStats"] = {
        filesScanned: 0,
        byExtension: {},
        truncated: false,
      };
      scanFiles(workspaceRoot, workspaceRoot, fileStats);
      throwIfAborted(context?.signal);
      const pkg = readPackage(workspaceRoot);
      return {
        workspaceRoot,
        package: pkg,
        topLevelEntries,
        fileStats,
        detected: detectProject(pkg, new Set(entries.map((entry) => entry.name))),
      };
    },
  };
}

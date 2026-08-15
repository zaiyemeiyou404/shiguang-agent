import { readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath } from "./path-format.js";

export interface ListDirectoryInput {
  path?: string;
}

export interface ListDirectoryOutput {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
    size: number;
  }>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function resolveInput(input: unknown): string {
  if (input === undefined || input === null) return ".";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.path === undefined) return ".";
    if (typeof obj.path === "string") return obj.path;
  }
  throw new Error("list_directory: input must be a path string or { path?: string }");
}

export function createListDirectoryTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "list_directory",
      description: "List files and subdirectories inside a workspace directory. Accepts a path string or { path }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute directory path inside workspace root" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.list",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<ListDirectoryOutput> {
      throwIfAborted(context?.signal);
      const requestedPath = resolveInput(input);
      const fullPath = resolveWorkspacePath(workspaceRoot, requestedPath);
      const dirStat = statSync(fullPath);
      if (!dirStat.isDirectory()) {
        throw new Error(`list_directory: path is not a directory: ${requestedPath}`);
      }
      const entries = readdirSync(fullPath)
        .map((name) => {
          throwIfAborted(context?.signal);
          const childPath = resolve(fullPath, name);
          const stats = statSync(childPath);
          return {
            name,
            path: relative(workspaceRoot, childPath) || basename(childPath),
            kind: stats.isDirectory() ? "directory" as const : "file" as const,
            size: stats.size,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        path: fullPath,
        entries,
      };
    },
  };
}

import { readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { isPathInside, resolveReadablePath } from "./path-policy.js";
import { toPortablePath } from "./path-format.js";

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
      description: "List a workspace-relative directory or an explicit absolute directory allowed by the operating system.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory or explicit absolute directory" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.list",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<ListDirectoryOutput> {
      throwIfAborted(context?.signal);
      const requestedPath = resolveInput(input);
      const fullPath = resolveReadablePath(workspaceRoot, requestedPath);
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
            path: isPathInside(workspaceRoot, childPath)
              ? toPortablePath(relative(workspaceRoot, childPath) || basename(childPath))
              : childPath,
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

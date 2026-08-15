import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toPortablePath } from "./path-format.js";

export interface StatPathOutput {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function resolveInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.path === "string") return obj.path;
  }
  throw new Error("stat_path: input must be a path string or { path: string }");
}

export function createStatPathTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "stat_path",
      description: "Return basic metadata for a file or directory inside the workspace. Accepts a path string or { path }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path inside workspace root" },
        },
        required: ["path"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.stat",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<StatPathOutput> {
      throwIfAborted(context?.signal);
      const rawPath = resolveInput(input);
      const fullPath = resolveWorkspacePath(workspaceRoot, rawPath);
      try {
        accessSync(fullPath, constants.R_OK);
      } catch {
        throw new Error(`Path not found or not readable: ${rawPath}`);
      }
      const stats = statSync(fullPath);
      return {
        path: toPortablePath(fullPath),
        name: basename(fullPath),
        kind: stats.isDirectory() ? "directory" : "file",
        size: stats.size,
      };
    },
  };
}

import { existsSync, rmSync, statSync } from "node:fs";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath } from "./path-format.js";

export interface DeletePathInput {
  path: string;
  recursive?: boolean;
}

export interface DeletePathOutput {
  path: string;
  kind: "file" | "directory";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function resolveInput(input: unknown): DeletePathInput {
  if (!input || typeof input !== "object") {
    throw new Error("delete_path: input must be { path: string, recursive?: boolean }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.path !== "string") {
    throw new Error("delete_path: path must be a string");
  }
  if (obj.recursive !== undefined && typeof obj.recursive !== "boolean") {
    throw new Error("delete_path: recursive must be boolean when provided");
  }
  return { path: obj.path, recursive: obj.recursive as boolean | undefined };
}

export function createDeletePathTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "delete_path",
      description: "Delete a workspace file or directory. Accepts { path, recursive? }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
      risk: "write",
      requiresApproval: true,
      capability: "fs.delete",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<DeletePathOutput> {
      throwIfAborted(context?.signal);
      const { path, recursive } = resolveInput(input);
      const fullPath = resolveWorkspacePath(workspaceRoot, path);
      if (!existsSync(fullPath)) {
        throw new Error(`delete_path: path not found: ${path}`);
      }
      const stats = statSync(fullPath);
      if (stats.isDirectory() && recursive !== true) {
        throw new Error(`delete_path: ${path} is a directory; pass recursive: true to delete it`);
      }
      rmSync(fullPath, { recursive: recursive === true, force: false });
      return {
        path: fullPath,
        kind: stats.isDirectory() ? "directory" : "file",
      };
    },
  };
}

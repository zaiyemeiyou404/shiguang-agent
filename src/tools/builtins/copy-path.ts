import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";

export interface CopyPathInput {
  sourcePath: string;
  destinationPath: string;
}

export interface CopyPathOutput {
  sourcePath: string;
  destinationPath: string;
  bytes: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function resolveInput(input: unknown): CopyPathInput {
  if (!input || typeof input !== "object") {
    throw new Error("copy_path: input must be { sourcePath: string, destinationPath: string }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.sourcePath !== "string" || typeof obj.destinationPath !== "string") {
    throw new Error("copy_path: sourcePath and destinationPath must be strings");
  }
  return { sourcePath: obj.sourcePath, destinationPath: obj.destinationPath };
}

function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  const candidate = resolve(workspaceRoot, normalize(userPath));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

export function createCopyPathTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "copy_path",
      description: "Copy a workspace file to another workspace path. Accepts { sourcePath, destinationPath }.",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: { type: "string" },
          destinationPath: { type: "string" },
        },
        required: ["sourcePath", "destinationPath"],
      },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
      risk: "write",
      requiresApproval: true,
      capability: "fs.copy",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<CopyPathOutput> {
      throwIfAborted(context?.signal);
      const { sourcePath, destinationPath } = resolveInput(input);
      const sourceFullPath = resolveWorkspacePath(workspaceRoot, sourcePath);
      const destinationFullPath = resolveWorkspacePath(workspaceRoot, destinationPath);
      const sourceStats = statSync(sourceFullPath);
      if (!sourceStats.isFile()) {
        throw new Error(`copy_path: source is not a file: ${sourcePath}`);
      }
      mkdirSync(dirname(destinationFullPath), { recursive: true });
      copyFileSync(sourceFullPath, destinationFullPath);
      return {
        sourcePath: sourceFullPath,
        destinationPath: destinationFullPath,
        bytes: sourceStats.size,
      };
    },
  };
}

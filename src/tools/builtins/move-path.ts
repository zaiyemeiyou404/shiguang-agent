import { mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toPortablePath } from "./path-format.js";

export interface MovePathInput {
  sourcePath: string;
  destinationPath: string;
}

export interface MovePathOutput {
  sourcePath: string;
  destinationPath: string;
  bytes: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function resolveInput(input: unknown): MovePathInput {
  if (!input || typeof input !== "object") {
    throw new Error("move_path: input must be { sourcePath: string, destinationPath: string }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.sourcePath !== "string" || typeof obj.destinationPath !== "string") {
    throw new Error("move_path: sourcePath and destinationPath must be strings");
  }
  return { sourcePath: obj.sourcePath, destinationPath: obj.destinationPath };
}

export function createMovePathTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "move_path",
      description: "Move or rename a workspace file or directory to another workspace path. Accepts { sourcePath, destinationPath }.",
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
      capability: "fs.move",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<MovePathOutput> {
      throwIfAborted(context?.signal);
      const { sourcePath, destinationPath } = resolveInput(input);
      const sourceFullPath = resolveWorkspacePath(workspaceRoot, sourcePath);
      const destinationFullPath = resolveWorkspacePath(workspaceRoot, destinationPath, { forWrite: true });
      const sourceStats = statSync(sourceFullPath);
      mkdirSync(dirname(destinationFullPath), { recursive: true });
      renameSync(sourceFullPath, destinationFullPath);
      return {
        sourcePath: toPortablePath(sourceFullPath),
        destinationPath: toPortablePath(destinationFullPath),
        bytes: sourceStats.size,
      };
    },
  };
}

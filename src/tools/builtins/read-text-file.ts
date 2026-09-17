import { accessSync, readFileSync, constants } from "node:fs";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveReadablePath } from "./path-policy.js";

const MAX_BYTES = 16_384;

export interface ReadTextFileInput {
  path: string;
}

export interface ReadTextFileOutput {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

function resolveInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.path === "string") return obj.path;
  }
  throw new Error("read_text_file: input must be a string path or { path: string }");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createReadTextFileTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "read_text_file",
      description: "Read text content from a workspace-relative path or an explicit absolute path allowed by the operating system.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path or explicit absolute path" },
        },
        required: ["path"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.read",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<ReadTextFileOutput> {
      throwIfAborted(context?.signal);
      const rawPath = resolveInput(input);
      const fullPath = resolveReadablePath(workspaceRoot, rawPath);
      throwIfAborted(context?.signal);

      try {
        accessSync(fullPath, constants.R_OK);
      } catch {
        throw new Error(`File not found or not readable: ${rawPath}`);
      }

      const buf = readFileSync(fullPath);
      const bytes = buf.length;
      const truncated = bytes > MAX_BYTES;
      const content = buf.toString("utf-8").slice(0, MAX_BYTES);

      return { path: fullPath, content, truncated, bytes };
    },
  };
}

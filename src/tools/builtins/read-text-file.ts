import { accessSync, readFileSync, constants } from "node:fs";
import { resolve, normalize, relative } from "node:path";
import type { Tool } from "../types.js";

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

function resolvePath(workspaceRoot: string, userPath: string): string {
  const candidate = resolve(workspaceRoot, normalize(userPath));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

export function createReadTextFileTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "read_text_file",
      description: "Read text content from a file within the workspace. Accepts a path string or { path } object.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path inside workspace root" },
        },
        required: ["path"],
      },
    },
    async execute(input: unknown): Promise<ReadTextFileOutput> {
      const rawPath = resolveInput(input);
      const fullPath = resolvePath(workspaceRoot, rawPath);

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

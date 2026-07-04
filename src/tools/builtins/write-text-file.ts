import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, normalize, relative } from "node:path";
import type { Tool } from "../types.js";

export interface WriteTextFileInput {
  path: string;
  content: string;
}

export interface WriteTextFileOutput {
  path: string;
  bytes: number;
}

function resolveInput(input: unknown): WriteTextFileInput {
  if (!input || typeof input !== "object") {
    throw new Error("write_text_file: input must be { path: string, content: string }");
  }

  const obj = input as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.content !== "string") {
    throw new Error("write_text_file: input must include string path and content");
  }

  return { path: obj.path, content: obj.content };
}

function resolvePath(workspaceRoot: string, userPath: string): string {
  const candidate = resolve(workspaceRoot, normalize(userPath));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

export function createWriteTextFileTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "write_text_file",
      description: "Overwrite a text file inside the workspace. Creates parent directories if needed. Accepts { path, content }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path inside workspace root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
    },
    async execute(input: unknown): Promise<WriteTextFileOutput> {
      const { path, content } = resolveInput(input);
      const fullPath = resolvePath(workspaceRoot, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      return {
        path: fullPath,
        bytes: Buffer.byteLength(content),
      };
    },
  };
}

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, normalize, relative } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { toPortablePath } from "./path-format.js";
import { createTextDiffPreview } from "./approval-preview.js";

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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
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
      risk: "write",
      requiresApproval: true,
      capability: "fs.write",
    },
    previewApproval(input: unknown): ReturnType<NonNullable<Tool["previewApproval"]>> {
      const { path, content } = resolveInput(input);
      const fullPath = resolvePath(workspaceRoot, path);
      const relativePath = toPortablePath(relative(workspaceRoot, fullPath));
      const warnings: string[] = [];
      let before = "";
      let operation = "create";

      if (existsSync(fullPath)) {
        const stats = statSync(fullPath);
        operation = "overwrite";
        if (!stats.isFile()) {
          return {
            kind: "summary",
            title: `Cannot preview write: ${relativePath}`,
            path: relativePath,
            operation,
            warnings: [`Target exists but is not a file: ${relativePath}`],
          };
        }
        if (stats.size > 1_048_576) {
          warnings.push("Existing file is larger than 1MB; preview only compares against an empty baseline.");
        } else {
          before = readFileSync(fullPath, "utf8");
        }
      }

      return createTextDiffPreview({
        path: relativePath,
        before,
        after: content,
        operation,
        warnings,
      });
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<WriteTextFileOutput> {
      throwIfAborted(context?.signal);
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

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, normalize, relative } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { toPortablePath } from "./path-format.js";
import { createTextDiffPreview } from "./approval-preview.js";

export interface PatchTextFileInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface PatchTextFileOutput {
  path: string;
  replacements: number;
  bytes: number;
}

function resolveInput(input: unknown): PatchTextFileInput {
  if (!input || typeof input !== "object") {
    throw new Error("patch_text_file: input must be { path: string, oldString: string, newString: string, replaceAll?: boolean }");
  }

  const obj = input as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.oldString !== "string" || typeof obj.newString !== "string") {
    throw new Error("patch_text_file: path, oldString, and newString must be strings");
  }
  if (obj.oldString.length === 0) {
    throw new Error("patch_text_file: oldString must not be empty");
  }
  if (obj.replaceAll !== undefined && typeof obj.replaceAll !== "boolean") {
    throw new Error("patch_text_file: replaceAll must be boolean when provided");
  }

  return {
    path: obj.path,
    oldString: obj.oldString,
    newString: obj.newString,
    replaceAll: obj.replaceAll,
  };
}

function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  const candidate = resolve(workspaceRoot, normalize(userPath));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createPatchTextFileTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "patch_text_file",
      description: "Patch a text file by replacing oldString with newString. Accepts { path, oldString, newString, replaceAll? }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path inside workspace root" },
          oldString: { type: "string", description: "Exact text to replace" },
          newString: { type: "string", description: "Replacement text" },
          replaceAll: { type: "boolean", description: "Replace all occurrences instead of requiring exactly one match" },
        },
        required: ["path", "oldString", "newString"],
      },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
      risk: "write",
      requiresApproval: true,
      capability: "fs.patch",
    },
    previewApproval(input: unknown): ReturnType<NonNullable<Tool["previewApproval"]>> {
      const { path, oldString, newString, replaceAll } = resolveInput(input);
      const fullPath = resolveWorkspacePath(workspaceRoot, path);
      const relativePath = toPortablePath(relative(workspaceRoot, fullPath));
      const before = readFileSync(fullPath, "utf8");
      const occurrences = countOccurrences(before, oldString);
      const warnings: string[] = [];

      if (occurrences === 0) {
        warnings.push("oldString was not found; approving this action will likely fail.");
      }
      if (!replaceAll && occurrences > 1) {
        warnings.push(`oldString matched ${occurrences} times; execution requires replaceAll: true.`);
      }

      const shouldApplyPreview = occurrences > 0 && (replaceAll === true || occurrences === 1);
      const after = shouldApplyPreview
        ? replaceAll === true
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString)
        : before;

      return createTextDiffPreview({
        path: relativePath,
        before,
        after,
        operation: "patch",
        warnings,
      });
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<PatchTextFileOutput> {
      // patch_text_file 强依赖“精确命中次数”，这样 planner 才能做可验证的最小补丁。
      const { path, oldString, newString, replaceAll } = resolveInput(input);
      throwIfAborted(context?.signal);
      const fullPath = resolveWorkspacePath(workspaceRoot, path);
      const before = readFileSync(fullPath, "utf8");
      const occurrences = countOccurrences(before, oldString);

      if (occurrences === 0) {
        throw new Error(`patch_text_file: oldString not found in ${path}`);
      }
      if (!replaceAll && occurrences !== 1) {
        // 多命中默认拒绝，逼 planner 明确表达 replaceAll，避免误改一片相似代码。
        throw new Error(`patch_text_file: oldString matched ${occurrences} times in ${path}; pass replaceAll: true to replace all`);
      }

      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);
      const replacements = replaceAll ? occurrences : 1;
      writeFileSync(fullPath, after, "utf8");

      return {
        path: fullPath,
        replacements,
        bytes: Buffer.byteLength(after),
      };
    },
  };
}

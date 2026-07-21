import { normalize, relative, resolve } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { runGit } from "./git-utils.js";
import { toPortablePath } from "./path-format.js";

export interface GitDiffInput {
  path?: string;
  staged?: boolean;
  maxChars?: number;
}

export interface GitDiffOutput {
  ok: boolean;
  path: string | null;
  staged: boolean;
  diff: string;
  stderr: string;
  truncated: boolean;
}

function resolveInput(input: unknown): GitDiffInput {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object") {
    throw new Error("git_diff: input must be { path?: string, staged?: boolean, maxChars?: number }");
  }
  const obj = input as Record<string, unknown>;
  if (obj.path !== undefined && typeof obj.path !== "string") {
    throw new Error("git_diff: path must be a string when provided");
  }
  if (obj.staged !== undefined && typeof obj.staged !== "boolean") {
    throw new Error("git_diff: staged must be boolean when provided");
  }
  if (obj.maxChars !== undefined && typeof obj.maxChars !== "number") {
    throw new Error("git_diff: maxChars must be number when provided");
  }
  return {
    path: obj.path,
    staged: obj.staged,
    maxChars: obj.maxChars,
  };
}

function resolveWorkspaceRelativePath(workspaceRoot: string, userPath: string): string {
  const candidate = resolve(workspaceRoot, normalize(userPath));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return toPortablePath(rel);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createGitDiffTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "git_diff",
      description: "Read Git diff for the workspace or one path. Accepts { path?, staged?, maxChars? }. Use to review changes before answering.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace-relative path" },
          staged: { type: "boolean", description: "Show staged diff instead of unstaged diff" },
          maxChars: { type: "number", description: "Maximum diff characters to return" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "git.diff",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<GitDiffOutput> {
      throwIfAborted(context?.signal);
      const parsed = resolveInput(input);
      const maxChars = Number.isFinite(parsed.maxChars) && (parsed.maxChars ?? 0) > 0
        ? Math.min(Math.trunc(parsed.maxChars as number), 60_000)
        : 20_000;
      const args = ["diff", "--no-ext-diff", "--unified=3"];
      if (parsed.staged) args.push("--cached");
      const relPath = parsed.path ? resolveWorkspaceRelativePath(workspaceRoot, parsed.path) : null;
      if (relPath) args.push("--", relPath);
      const result = await runGit(workspaceRoot, args, maxChars);
      throwIfAborted(context?.signal);
      return {
        ok: result.ok,
        path: relPath,
        staged: parsed.staged === true,
        diff: result.stdout,
        stderr: result.stderr,
        truncated: result.stdout.includes("...[truncated]"),
      };
    },
  };
}

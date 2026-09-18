import type { Tool, ToolApprovalPreview, ToolExecutionContext } from "../types.js";
import { runGit } from "./git-utils.js";

type GitCommitInput = { message: string; paths?: string[] };

function parseInput(input: unknown): GitCommitInput {
  if (!input || typeof input !== "object") throw new Error("git_commit: input must be { message, paths? }");
  const value = input as Record<string, unknown>;
  if (typeof value.message !== "string" || !value.message.trim()) throw new Error("git_commit: message is required");
  if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.some((path) => typeof path !== "string" || !path.trim()))) {
    throw new Error("git_commit: paths must be a list of non-empty workspace-relative paths");
  }
  return { message: value.message.trim().slice(0, 240), paths: value.paths as string[] | undefined };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
}

export function createGitCommitTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "git_commit",
      description: "Create a local Git commit after explicit approval. Accepts { message, paths? }. Never pushes to a remote.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
        required: ["message"],
      },
      risk: "execute",
      requiresApproval: true,
      capability: "git.commit",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const parsed = parseInput(input);
      return {
        kind: "summary",
        title: "创建本地 Git 提交",
        operation: "git commit",
        warnings: ["会写入本地 Git 历史；不会向远程仓库推送。"],
        diff: `message: ${parsed.message}\npaths: ${(parsed.paths?.join(", ") || "已暂存的全部改动")}`,
      };
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const parsed = parseInput(input);
      throwIfAborted(context?.signal);
      const args = ["commit", "-m", parsed.message];
      if (parsed.paths?.length) args.push("--", ...parsed.paths);
      const result = await runGit(workspaceRoot, args);
      throwIfAborted(context?.signal);
      return { ...result, message: parsed.message, paths: parsed.paths ?? null };
    },
  };
}

import type { Tool, ToolApprovalPreview, ToolExecutionContext } from "../types.js";
import { runGit } from "./git-utils.js";

type GitPushInput = { remote?: string; branch?: string; setUpstream?: boolean };

function parseInput(input: unknown): GitPushInput {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object") throw new Error("git_push: input must be { remote?, branch?, setUpstream? }");
  const value = input as Record<string, unknown>;
  for (const key of ["remote", "branch"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`git_push: ${key} must be a string`);
  if (value.setUpstream !== undefined && typeof value.setUpstream !== "boolean") throw new Error("git_push: setUpstream must be boolean");
  return { remote: value.remote as string | undefined, branch: value.branch as string | undefined, setUpstream: value.setUpstream as boolean | undefined };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
}

export function createGitPushTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "git_push",
      description: "Push Git commits to a remote only after explicit single-use approval. Accepts { remote?, branch?, setUpstream? }.",
      inputSchema: { type: "object", properties: { remote: { type: "string" }, branch: { type: "string" }, setUpstream: { type: "boolean" } } },
      risk: "execute",
      requiresApproval: true,
      capability: "git.push",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const parsed = parseInput(input);
      return {
        kind: "summary",
        title: "推送 Git 提交到远程仓库",
        operation: "git push",
        warnings: ["会修改远程仓库历史或分支状态；此操作必须每次单独确认。"],
        diff: `remote: ${parsed.remote ?? "默认远程"}\nbranch: ${parsed.branch ?? "当前分支"}\nsetUpstream: ${parsed.setUpstream === true}`,
      };
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const parsed = parseInput(input);
      throwIfAborted(context?.signal);
      const args = ["push"];
      if (parsed.setUpstream) args.push("--set-upstream");
      if (parsed.remote) args.push(parsed.remote);
      if (parsed.branch) args.push(parsed.branch);
      const result = await runGit(workspaceRoot, args);
      throwIfAborted(context?.signal);
      return { ...result, remote: parsed.remote ?? null, branch: parsed.branch ?? null, setUpstream: parsed.setUpstream === true };
    },
  };
}

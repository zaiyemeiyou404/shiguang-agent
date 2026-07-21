import type { Tool, ToolExecutionContext } from "../types.js";
import { runGit } from "./git-utils.js";

export interface GitStatusOutput {
  ok: boolean;
  branch: string | null;
  status: string;
  porcelain: string;
  stderr: string;
}

function parseBranch(statusOutput: string): string | null {
  const firstLine = statusOutput.split(/\r?\n/)[0] ?? "";
  const unbornMatch = firstLine.match(/^## No commits yet on (.+)$/);
  if (unbornMatch?.[1]) return unbornMatch[1];
  const match = firstLine.match(/^##\s+([^\s.]+|[^\s]+?)(?:\.\.\.|$)/);
  return match?.[1] ?? null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createGitStatusTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "git_status",
      description: "Read the current Git branch and short workspace status. Use before editing or summarizing repository changes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      risk: "read",
      requiresApproval: false,
      capability: "git.status",
    },
    async execute(_input: unknown, context?: ToolExecutionContext): Promise<GitStatusOutput> {
      throwIfAborted(context?.signal);
      const result = await runGit(workspaceRoot, ["status", "--short", "--branch", "--untracked-files=normal"]);
      throwIfAborted(context?.signal);
      return {
        ok: result.ok,
        branch: result.ok ? parseBranch(result.stdout) : null,
        status: result.stdout.trim(),
        porcelain: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

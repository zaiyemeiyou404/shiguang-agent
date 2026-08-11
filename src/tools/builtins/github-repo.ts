import { execFile } from "node:child_process";
import { resolve, normalize, relative } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolExecutionContext } from "../types.js";

const execFileAsync = promisify(execFile);
const GITHUB_API = "https://api.github.com";

type GitHubAction = "repo_summary" | "issues" | "pulls" | "workflow_runs" | "latest_release";

interface GitHubRepoInput {
  action?: GitHubAction;
  owner?: string;
  repo?: string;
  remote?: string;
  state?: "open" | "closed" | "all";
  limit?: number;
}

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

function parseInput(input: unknown): GitHubRepoInput {
  if (!input || typeof input !== "object") return { action: "repo_summary" };
  const obj = input as Record<string, unknown>;
  return {
    action: isGitHubAction(obj.action) ? obj.action : "repo_summary",
    ...(typeof obj.owner === "string" ? { owner: obj.owner } : {}),
    ...(typeof obj.repo === "string" ? { repo: obj.repo } : {}),
    ...(typeof obj.remote === "string" ? { remote: obj.remote } : {}),
    ...(obj.state === "open" || obj.state === "closed" || obj.state === "all" ? { state: obj.state } : {}),
    ...(typeof obj.limit === "number" ? { limit: obj.limit } : {}),
  };
}

function isGitHubAction(value: unknown): value is GitHubAction {
  return value === "repo_summary"
    || value === "issues"
    || value === "pulls"
    || value === "workflow_runs"
    || value === "latest_release";
}

function normalizeLimit(value: number | undefined): number {
  return Math.max(1, Math.min(50, Math.trunc(value ?? 10)));
}

function resolveWorkspacePath(workspaceRoot: string): string {
  const candidate = resolve(workspaceRoot, normalize("."));
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error("github_repo: workspace root resolution escaped unexpectedly");
  }
  return candidate;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function parseGitHubRemote(value: string): GitHubRepoRef | null {
  const trimmed = value.trim();
  const match = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (!match?.[1] || !match?.[2]) return null;
  return {
    owner: match[1],
    repo: match[2],
  };
}

async function inferRemote(workspaceRoot: string, remoteName: string): Promise<GitHubRepoRef | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remoteName], {
      cwd: resolveWorkspacePath(workspaceRoot),
      windowsHide: true,
      timeout: 5_000,
    });
    return parseGitHubRemote(stdout);
  } catch {
    return null;
  }
}

async function fetchGitHubJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "shiguang-agent",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}${text ? ` - ${text.slice(0, 300)}` : ""}`);
  }
  return response.json();
}

async function resolveRepo(input: GitHubRepoInput, workspaceRoot: string): Promise<GitHubRepoRef> {
  if (input.owner?.trim() && input.repo?.trim()) {
    return { owner: input.owner.trim(), repo: input.repo.trim().replace(/\.git$/i, "") };
  }
  const inferred = await inferRemote(workspaceRoot, input.remote?.trim() || "origin");
  if (inferred) return inferred;
  throw new Error("github_repo: provide { owner, repo } or configure a GitHub origin remote in the workspace.");
}

function compactIssue(item: Record<string, unknown>): Record<string, unknown> {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    url: item.html_url,
    author: typeof item.user === "object" && item.user ? (item.user as Record<string, unknown>).login : undefined,
    updatedAt: item.updated_at,
  };
}

function compactWorkflowRun(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    conclusion: item.conclusion,
    branch: item.head_branch,
    url: item.html_url,
    updatedAt: item.updated_at,
  };
}

export function createGitHubRepoTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "github_repo",
      description: "Read GitHub repository metadata, issues, pull requests, workflow runs, or latest release. Uses { action, owner?, repo?, state?, limit? } and can infer owner/repo from git origin.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["repo_summary", "issues", "pulls", "workflow_runs", "latest_release"] },
          owner: { type: "string" },
          repo: { type: "string" },
          remote: { type: "string", description: "Git remote name to infer owner/repo from, default origin" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          limit: { type: "number" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "github.read",
    },
    async execute(rawInput: unknown, context?: ToolExecutionContext): Promise<unknown> {
      throwIfAborted(context?.signal);
      const input = parseInput(rawInput);
      const repo = await resolveRepo(input, workspaceRoot);
      const action = input.action ?? "repo_summary";
      const limit = normalizeLimit(input.limit);
      const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

      if (action === "repo_summary") {
        const data = await fetchGitHubJson(repoPath, context?.signal) as Record<string, unknown>;
        return {
          owner: repo.owner,
          repo: repo.repo,
          fullName: data.full_name,
          description: data.description,
          defaultBranch: data.default_branch,
          stars: data.stargazers_count,
          forks: data.forks_count,
          openIssues: data.open_issues_count,
          url: data.html_url,
          pushedAt: data.pushed_at,
        };
      }

      if (action === "latest_release") {
        return fetchGitHubJson(`${repoPath}/releases/latest`, context?.signal);
      }

      if (action === "workflow_runs") {
        const data = await fetchGitHubJson(`${repoPath}/actions/runs?per_page=${limit}`, context?.signal) as { workflow_runs?: unknown };
        const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
        return { owner: repo.owner, repo: repo.repo, runs: runs.map((item) => compactWorkflowRun(item as Record<string, unknown>)) };
      }

      const state = input.state ?? "open";
      const endpoint = action === "pulls" ? "pulls" : "issues";
      const data = await fetchGitHubJson(`${repoPath}/${endpoint}?state=${state}&per_page=${limit}`, context?.signal);
      const items = Array.isArray(data) ? data : [];
      return {
        owner: repo.owner,
        repo: repo.repo,
        action,
        state,
        items: items.map((item) => compactIssue(item as Record<string, unknown>)),
      };
    },
  };
}

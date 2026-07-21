import { spawn } from "node:child_process";

const MAX_GIT_OUTPUT_CHARS = 20_000;

export interface GitCommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function trimGitOutput(value: string, maxChars = MAX_GIT_OUTPUT_CHARS): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

export function runGit(workspaceRoot: string, args: string[], maxChars?: number): Promise<GitCommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", workspaceRoot, ...args], {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolvePromise({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolvePromise({
        ok: exitCode === 0,
        exitCode,
        stdout: trimGitOutput(stdout, maxChars),
        stderr: trimGitOutput(stderr, maxChars),
      });
    });
  });
}

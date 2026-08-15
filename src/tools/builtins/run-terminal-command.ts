import { spawn } from "node:child_process";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath } from "./path-format.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 8_000;

export interface RunTerminalCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunTerminalCommandOutput {
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function resolveInput(input: unknown): RunTerminalCommandInput {
  if (!input || typeof input !== "object") {
    throw new Error("run_terminal_command: input must be { command: string, cwd?: string, timeoutMs?: number }");
  }

  const obj = input as Record<string, unknown>;
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    throw new Error("run_terminal_command: command must be a non-empty string");
  }
  if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
    throw new Error("run_terminal_command: cwd must be a string when provided");
  }
  if (obj.timeoutMs !== undefined && typeof obj.timeoutMs !== "number") {
    throw new Error("run_terminal_command: timeoutMs must be a number when provided");
  }

  return {
    command: obj.command,
    cwd: obj.cwd,
    timeoutMs: obj.timeoutMs,
  };
}

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createRunTerminalCommandTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "run_terminal_command",
      description: "Run a shell command inside the workspace. Accepts { command, cwd?, timeoutMs? } and returns exit code plus stdout/stderr.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run inside the workspace" },
          cwd: { type: "string", description: "Optional relative subdirectory inside the workspace" },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds" },
        },
        required: ["command"],
      },
      effects: {
        validationMode: "all",
      },
      risk: "execute",
      requiresApproval: true,
      capability: "process.exec",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<RunTerminalCommandOutput> {
      throwIfAborted(context?.signal);
      const { command, cwd, timeoutMs } = resolveInput(input);
      const workingDirectory = resolveWorkspacePath(workspaceRoot, cwd);
      const timeout = Number.isFinite(timeoutMs) && (timeoutMs ?? 0) > 0
        ? Math.min(Math.trunc(timeoutMs as number), 120_000)
        : DEFAULT_TIMEOUT_MS;

      return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, {
          cwd: workingDirectory,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;

        const abortHandler = () => {
          if (settled) return;
          // stop/cancel 必须真正终止子进程，不能只在上层把 run 标成 cancelled。
          child.kill();
          rejectPromise(new DOMException("Run cancelled", "AbortError"));
        };

        const finish = (exitCode: number, ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context?.signal?.removeEventListener("abort", abortHandler);
          resolvePromise({
            command,
            cwd: workingDirectory,
            ok,
            exitCode,
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
            timedOut,
          });
        };

        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          stderr += error instanceof Error ? error.message : String(error);
          finish(1, false);
        });
        child.on("close", (code) => {
          if (context?.signal?.aborted && !settled) {
            abortHandler();
            return;
          }
          const exitCode = code ?? (timedOut ? 124 : 1);
          finish(exitCode, exitCode === 0 && !timedOut);
        });

        if (context?.signal?.aborted) {
          abortHandler();
          return;
        }
        context?.signal?.addEventListener("abort", abortHandler, { once: true });

        const timer = setTimeout(() => {
          timedOut = true;
          // timeout 与人工 abort 共享同一 kill 语义，保证长跑命令不会继续挂着。
          child.kill();
        }, timeout);
      });
    },
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalize, relative, resolve } from "node:path";
import type { Tool, ToolExecutionContext, ToolApprovalPreview } from "../types.js";

const MAX_BUFFER = 20_000;

interface ProcessRecord {
  id: string;
  name: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: Date;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  endedAt: Date | null;
}

const processes = new Map<string, ProcessRecord>();

function resolveWorkspacePath(workspaceRoot: string, userPath?: string): string {
  const candidate = userPath ? resolve(workspaceRoot, normalize(userPath)) : workspaceRoot;
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

function appendBuffer(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
}

function summary(record: ProcessRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    command: record.command,
    cwd: record.cwd,
    pid: record.child.pid,
    running: record.exitCode === null,
    exitCode: record.exitCode,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt?.toISOString() ?? null,
  };
}

export function createStartBackgroundProcessTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "start_background_process",
      description: "Start a long-running background process inside the workspace, such as a dev server. Accepts { command, cwd?, name? }.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          name: { type: "string" },
        },
        required: ["command"],
      },
      risk: "execute",
      requiresApproval: true,
      capability: "process.background.start",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
      return {
        kind: "summary",
        title: "Start background process",
        operation: "start",
        warnings: [`Command: ${typeof obj.command === "string" ? obj.command : "(missing)"}`],
      };
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      if (!input || typeof input !== "object") {
        throw new Error("start_background_process: input must be { command, cwd?, name? }");
      }
      const obj = input as Record<string, unknown>;
      if (typeof obj.command !== "string" || !obj.command.trim()) {
        throw new Error("start_background_process: command must be a non-empty string");
      }
      const cwd = resolveWorkspacePath(workspaceRoot, typeof obj.cwd === "string" ? obj.cwd : undefined);
      const id = `proc_${randomUUID().slice(0, 8)}`;
      const child = spawn(obj.command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const record: ProcessRecord = {
        id,
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : obj.command.slice(0, 60),
        command: obj.command,
        cwd,
        child,
        startedAt: new Date(),
        stdout: "",
        stderr: "",
        exitCode: null,
        endedAt: null,
      };
      processes.set(id, record);
      child.stdout.on("data", (chunk) => { record.stdout = appendBuffer(record.stdout, chunk); });
      child.stderr.on("data", (chunk) => { record.stderr = appendBuffer(record.stderr, chunk); });
      child.on("close", (code) => {
        record.exitCode = code ?? 1;
        record.endedAt = new Date();
      });
      if (context?.signal?.aborted) {
        child.kill();
        throw new DOMException("Run cancelled", "AbortError");
      }
      return summary(record);
    },
  };
}

export function createListBackgroundProcessesTool(): Tool {
  return {
    descriptor: {
      name: "list_background_processes",
      description: "List background processes started by Shiguang Agent.",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
      requiresApproval: false,
      capability: "process.background.read",
    },
    async execute(): Promise<unknown> {
      return { processes: Array.from(processes.values()).map(summary) };
    },
  };
}

export function createReadBackgroundProcessTool(): Tool {
  return {
    descriptor: {
      name: "read_background_process",
      description: "Read recent stdout/stderr from a background process. Accepts { id }.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "process.background.read",
    },
    async execute(input: unknown): Promise<unknown> {
      const id = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      if (typeof id !== "string") throw new Error("read_background_process: id is required");
      const record = processes.get(id);
      if (!record) throw new Error(`Background process not found: ${id}`);
      return { ...summary(record), stdout: record.stdout, stderr: record.stderr };
    },
  };
}

export function createStopBackgroundProcessTool(): Tool {
  return {
    descriptor: {
      name: "stop_background_process",
      description: "Stop a background process started by Shiguang Agent. Accepts { id }.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      risk: "execute",
      requiresApproval: true,
      capability: "process.background.stop",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const id = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      return {
        kind: "summary",
        title: "Stop background process",
        operation: "stop",
        warnings: [`Process id: ${typeof id === "string" ? id : "(missing)"}`],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      const id = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      if (typeof id !== "string") throw new Error("stop_background_process: id is required");
      const record = processes.get(id);
      if (!record) throw new Error(`Background process not found: ${id}`);
      if (record.exitCode === null) {
        record.child.kill();
      }
      return { ...summary(record), stopped: true };
    },
  };
}

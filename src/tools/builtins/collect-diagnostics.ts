import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Tool, ToolExecutionContext } from "../types.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 12_000;

type DiagnosticsMode = "auto" | "typescript" | "javascript" | "python" | "json";

interface CollectDiagnosticsInput {
  path?: string;
  mode?: DiagnosticsMode;
  timeoutMs?: number;
}

interface Diagnostic {
  source: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
}

function parseInput(input: unknown): CollectDiagnosticsInput {
  if (typeof input === "string") return { path: input };
  if (!input || typeof input !== "object") return {};
  const obj = input as Record<string, unknown>;
  return {
    ...(typeof obj.path === "string" ? { path: obj.path } : {}),
    ...(isMode(obj.mode) ? { mode: obj.mode } : {}),
    ...(typeof obj.timeoutMs === "number" ? { timeoutMs: obj.timeoutMs } : {}),
  };
}

function isMode(value: unknown): value is DiagnosticsMode {
  return value === "auto"
    || value === "typescript"
    || value === "javascript"
    || value === "python"
    || value === "json";
}

function resolveWorkspacePath(workspaceRoot: string, userPath?: string): string {
  const candidate = userPath ? resolve(workspaceRoot, normalize(userPath)) : workspaceRoot;
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

function inferMode(path: string | undefined, workspaceRoot: string): DiagnosticsMode {
  const ext = extname(path ?? "").toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx") return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".json") return "json";
  if (existsSync(join(workspaceRoot, "tsconfig.json"))) return "typescript";
  if (existsSync(join(workspaceRoot, "package.json"))) return "javascript";
  return "json";
}

function normalizeTimeout(value: number | undefined): number {
  return Math.max(1_000, Math.min(60_000, Math.trunc(value ?? 20_000)));
}

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n...[truncated]` : value;
}

async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; command: string }> {
  const abortPromise = new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Run cancelled", "AbortError")), { once: true });
  });
  try {
    const result = await Promise.race([
      execFileAsync(file, args, {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 2,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      }),
      abortPromise,
    ]);
    return {
      ok: true,
      stdout: trimOutput(result.stdout ?? ""),
      stderr: trimOutput(result.stderr ?? ""),
      command: [file, ...args].join(" "),
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: trimOutput(err.stdout ?? ""),
      stderr: trimOutput(err.stderr ?? err.message ?? String(error)),
      command: [file, ...args].join(" "),
    };
  }
}

function findLocalTsc(workspaceRoot: string): { file: string; args: string[] } {
  const cmd = process.platform === "win32"
    ? join(workspaceRoot, "node_modules", ".bin", "tsc.cmd")
    : join(workspaceRoot, "node_modules", ".bin", "tsc");
  if (existsSync(cmd)) return { file: cmd, args: ["--noEmit", "--pretty", "false"] };
  return { file: "tsc", args: ["--noEmit", "--pretty", "false"] };
}

function parseDiagnostics(text: string, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const ts = trimmed.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)$/i)
      ?? trimmed.match(/^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+([^:]+):\s+(.+)$/i);
    if (ts) {
      diagnostics.push({
        source,
        file: ts[1],
        line: Number(ts[2]),
        column: Number(ts[3]),
        severity: ts[4]?.toLowerCase() === "warning" ? "warning" : "error",
        message: `${ts[5] ? `${ts[5]}: ` : ""}${ts[6] ?? ""}`.trim(),
      });
      continue;
    }

    const py = trimmed.match(/^(.+?):(\d+):(?:(\d+):)?\s*(.+)$/);
    if (py) {
      diagnostics.push({
        source,
        file: py[1],
        line: Number(py[2]),
        ...(py[3] ? { column: Number(py[3]) } : {}),
        severity: "error",
        message: py[4] ?? trimmed,
      });
      continue;
    }

    if (/error|exception|syntax/i.test(trimmed)) {
      diagnostics.push({ source, severity: "error", message: trimmed });
    }
  }
  return diagnostics.slice(0, 50);
}

function checkJson(path: string): { ok: boolean; diagnostics: Diagnostic[]; command: string; stdout: string; stderr: string } {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return { ok: true, diagnostics: [], command: "JSON.parse", stdout: "JSON parsed successfully.", stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [{ source: "json", file: path, severity: "error", message }],
      command: "JSON.parse",
      stdout: "",
      stderr: message,
    };
  }
}

export function createCollectDiagnosticsTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "collect_diagnostics",
      description: "Collect lightweight code diagnostics for TypeScript, JavaScript, Python, or JSON without mutating workspace files. Accepts { path?, mode?, timeoutMs? }.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "string", enum: ["auto", "typescript", "javascript", "python", "json"] },
          timeoutMs: { type: "number" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "diagnostics.read",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const parsed = parseInput(input);
      const targetPath = parsed.path ? resolveWorkspacePath(workspaceRoot, parsed.path) : undefined;
      const mode = parsed.mode && parsed.mode !== "auto" ? parsed.mode : inferMode(targetPath, workspaceRoot);
      const timeoutMs = normalizeTimeout(parsed.timeoutMs);

      if (mode === "json") {
        if (!targetPath) throw new Error("collect_diagnostics: JSON mode requires { path }");
        return { mode, targetPath, ...checkJson(targetPath) };
      }

      const command = mode === "typescript"
        ? findLocalTsc(workspaceRoot)
        : mode === "javascript"
          ? { file: "node", args: ["--check", targetPath ?? ""] }
          : { file: "python", args: ["-B", "-m", "py_compile", targetPath ?? ""] };

      if ((mode === "javascript" || mode === "python") && !targetPath) {
        throw new Error(`collect_diagnostics: ${mode} mode requires { path }`);
      }

      const result = await runCommand(command.file, command.args, workspaceRoot, timeoutMs, context?.signal);
      const combined = `${result.stdout}\n${result.stderr}`;
      return {
        mode,
        targetPath,
        command: result.command,
        ok: result.ok,
        diagnostics: parseDiagnostics(combined, mode),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

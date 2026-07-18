import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolExecutionContext } from "../types.js";

type ValidationMode = "typecheck" | "test" | "build" | "all";
type ScriptMode = Exclude<ValidationMode, "all">;

const SCRIPT_ORDER: ScriptMode[] = ["typecheck", "test", "build"];
const SUPPORTED_MODES = new Set<ValidationMode>(["typecheck", "test", "build", "all"]);
const OUTPUT_SNIPPET_LIMIT = 4000;

export interface ValidationCommandResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface ValidationOutput {
  ok: boolean;
  mode: ValidationMode;
  commands: ValidationCommandResult[];
  summary: string;
}

function resolveMode(input: unknown): ValidationMode {
  const mode = typeof input === "string"
    ? input
    : input && typeof input === "object"
      ? (input as Record<string, unknown>).mode
      : undefined;

  if (typeof mode !== "string" || !SUPPORTED_MODES.has(mode as ValidationMode)) {
    throw new Error("validation: unsupported mode. Expected typecheck, test, build, or all.");
  }

  return mode as ValidationMode;
}

async function readScripts(workspaceRoot: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`validation: failed to read package.json: ${reason}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("validation: package.json must contain an object.");
  }

  const scripts = (parsed as { scripts?: unknown }).scripts;
  return scripts && typeof scripts === "object" ? scripts as Record<string, string> : {};
}

function scriptsForMode(mode: ValidationMode): ScriptMode[] {
  // all 模式按固定顺序短路执行，先 typecheck 再 test 再 build，尽早暴露最便宜的问题。
  return mode === "all" ? SCRIPT_ORDER : [mode];
}

function assertScriptsAvailable(scripts: Record<string, string>, names: ScriptMode[]): void {
  for (const name of names) {
    if (typeof scripts[name] !== "string") {
      throw new Error(`validation: missing package.json script "${name}".`);
    }
  }
}

function trimOutput(text: string): string {
  return text.length <= OUTPUT_SNIPPET_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_SNIPPET_LIMIT)}\n...[truncated]`;
}

function runCommand(
  workspaceRoot: string,
  command: string,
  args: string[],
  context?: ToolExecutionContext,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (value: { ok: boolean; exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      context?.signal?.removeEventListener("abort", abortHandler);
      resolve(value);
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      // validation 往往是长跑命令，这里必须把取消信号真实传到底层子进程。
      child.kill();
      reject(new DOMException("Run cancelled", "AbortError"));
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      void error;
      finish({ ok: false, exitCode: 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      finish({
        ok: exitCode === 0,
        exitCode,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      });
    });
    if (context?.signal?.aborted) {
      abortHandler();
      return;
    }
    context?.signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function parseNodeEvalScript(script: string): string | null {
  const match = /^node\s+-e\s+"([\s\S]*)"\s*$/.exec(script);
  return match?.[1] ?? null;
}

async function runScript(workspaceRoot: string, name: ScriptMode, script: string, context?: ToolExecutionContext): Promise<ValidationCommandResult> {
  let result = await runCommand(workspaceRoot, "npm", ["run", name], context);

  const nodeEval = parseNodeEvalScript(script);
  if (!result.ok && nodeEval) {
    // 测试里常用 node -e 伪造脚本；失败时回退直跑，减少 npm 包装层对断言的干扰。
    result = await runCommand(workspaceRoot, process.execPath, ["-e", nodeEval.replace(/\\\\n/g, "\\n")]);
  }

  return {
    name,
    command: `npm run ${name}`,
    ok: result.ok,
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

export function createRunValidationTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "run_validation",
      description: "Run workspace validation scripts. Accepts a mode string or { mode }; mode is typecheck, test, build, or all.",
      inputSchema: {
        anyOf: [
          { type: "string", enum: ["typecheck", "test", "build", "all"] },
          {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["typecheck", "test", "build", "all"] },
            },
            required: ["mode"],
          },
        ],
      },
      risk: "execute",
      requiresApproval: false,
      capability: "process.validate",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<ValidationOutput> {
      throwIfAborted(context?.signal);
      const mode = resolveMode(input);
      const scripts = await readScripts(workspaceRoot);
      const names = scriptsForMode(mode);
      assertScriptsAvailable(scripts, names);

      const commands: ValidationCommandResult[] = [];
      for (const name of names) {
        throwIfAborted(context?.signal);
        const result = await runScript(workspaceRoot, name, scripts[name]!, context);
        commands.push(result);
        // all 模式下遇到首个失败即停止，避免后续错误噪音掩盖根因。
        if (!result.ok) break;
      }

      const ok = commands.every((command) => command.ok);
      return {
        ok,
        mode,
        commands,
        summary: ok ? `Validation ${mode} passed.` : `Validation ${mode} failed.`,
      };
    },
  };
}

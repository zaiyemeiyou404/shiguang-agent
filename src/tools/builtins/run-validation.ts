import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Tool } from "../types.js";

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
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
      void error;
      resolve({ ok: false, exitCode: 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr) });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
      });
    });
  });
}

function parseNodeEvalScript(script: string): string | null {
  const match = /^node\s+-e\s+"([\s\S]*)"\s*$/.exec(script);
  return match?.[1] ?? null;
}

async function runScript(workspaceRoot: string, name: ScriptMode, script: string): Promise<ValidationCommandResult> {
  let result = await runCommand(workspaceRoot, "npm", ["run", name]);

  const nodeEval = parseNodeEvalScript(script);
  if (!result.ok && nodeEval) {
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
    },
    async execute(input: unknown): Promise<ValidationOutput> {
      const mode = resolveMode(input);
      const scripts = await readScripts(workspaceRoot);
      const names = scriptsForMode(mode);
      assertScriptsAvailable(scripts, names);

      const commands: ValidationCommandResult[] = [];
      for (const name of names) {
        const result = await runScript(workspaceRoot, name, scripts[name]!);
        commands.push(result);
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

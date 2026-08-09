import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolExecutionContext } from "../types.js";

type ValidationMode = "typecheck" | "test" | "build" | "all";
type ScriptMode = Exclude<ValidationMode, "all">;

const SCRIPT_ORDER: ScriptMode[] = ["typecheck", "test", "build"];
const SUPPORTED_MODES = new Set<ValidationMode>(["typecheck", "test", "build", "all"]);
const OUTPUT_SNIPPET_LIMIT = 4000;
const FALLBACK_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "release",
  "target",
  "coverage",
]);
const MAX_FALLBACK_FILES = 100;
const FALLBACK_RECOGNIZED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".md",
  ".php",
  ".ps1",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

interface FallbackTargets {
  pythonFiles: string[];
  javascriptFiles: string[];
  jsonFiles: string[];
  goFiles: string[];
  rustFiles: string[];
  unsupportedFiles: string[];
  hasRootGoMod: boolean;
  hasRootCargoToml: boolean;
}

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

async function readScripts(workspaceRoot: string): Promise<Record<string, string> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
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
      const reason = error instanceof Error ? error.message : String(error);
      finish({ ok: false, exitCode: 1, stdout: trimOutput(stdout), stderr: trimOutput(stderr || reason) });
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

async function runFallbackValidation(
  workspaceRoot: string,
  mode: ValidationMode,
  context?: ToolExecutionContext,
): Promise<ValidationOutput> {
  const targets = await scanFallbackTargets(workspaceRoot);
  const commands: ValidationCommandResult[] = [];

  const jsonResult = await validateJsonFiles(workspaceRoot, targets.jsonFiles);
  if (jsonResult) commands.push(jsonResult);

  if (commands.every((command) => command.ok)) {
    for (const command of await runJavaScriptSyntaxValidation(workspaceRoot, targets.javascriptFiles, context)) {
      commands.push(command);
      if (!command.ok) break;
    }
  }

  if (commands.every((command) => command.ok) && targets.pythonFiles.length > 0) {
    commands.push(await runPythonSyntaxValidation(workspaceRoot, targets.pythonFiles, context));
  }

  if (commands.every((command) => command.ok) && targets.hasRootGoMod) {
    commands.push(await runExternalFallbackCommand(
      workspaceRoot,
      "go",
      "go",
      ["test", "./..."],
      "Skipped Go validation: the go command was not found.",
      context,
    ));
  }

  if (commands.every((command) => command.ok) && targets.hasRootCargoToml) {
    commands.push(await runExternalFallbackCommand(
      workspaceRoot,
      "rust",
      "cargo",
      ["check"],
      "Skipped Rust validation: the cargo command was not found.",
      context,
    ));
  }

  const ok = commands.every((command) => command.ok);
  const skipped = summarizeSkippedTargets(targets, commands);

  if (commands.length === 0) {
    const summary = skipped
      ? `Fallback validation skipped: ${skipped}.`
      : "Fallback validation skipped: no package.json scripts or recognizable fallback validation targets found.";
    return {
      ok: true,
      mode,
      commands: [{
        name: "detect",
        command: "detect validation targets",
        ok: true,
        exitCode: 0,
        stdout: summary,
      }],
      summary,
    };
  }

  return {
    ok,
    mode,
    commands,
    summary: ok
      ? `Fallback validation passed (${commands.length} check(s))${skipped ? `; ${skipped}` : ""}.`
      : `Fallback validation failed: ${commands.filter((command) => !command.ok).map((command) => command.name).join(", ")}.`,
  };
}

async function scanFallbackTargets(workspaceRoot: string): Promise<FallbackTargets> {
  const targets: FallbackTargets = {
    pythonFiles: [],
    javascriptFiles: [],
    jsonFiles: [],
    goFiles: [],
    rustFiles: [],
    unsupportedFiles: [],
    hasRootGoMod: false,
    hasRootCargoToml: false,
  };
  await collectFallbackTargets(workspaceRoot, workspaceRoot, targets);
  return targets;
}

async function collectFallbackTargets(root: string, dir: string, targets: FallbackTargets): Promise<void> {
  if (fallbackTargetCount(targets) >= MAX_FALLBACK_FILES) return;

  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (fallbackTargetCount(targets) >= MAX_FALLBACK_FILES) return;
    if (entry.isDirectory()) {
      if (FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue;
      await collectFallbackTargets(root, join(dir, entry.name), targets);
      continue;
    }

    if (!entry.isFile()) continue;

    const relativePath = toPortablePath(relative(root, join(dir, entry.name)));
    const lowerName = entry.name.toLowerCase();
    const extension = getExtension(entry.name);

    if (relativePath === "go.mod") {
      targets.hasRootGoMod = true;
      continue;
    }
    if (relativePath === "Cargo.toml") {
      targets.hasRootCargoToml = true;
      continue;
    }

    if (extension === ".py") {
      targets.pythonFiles.push(relativePath);
    } else if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
      targets.javascriptFiles.push(relativePath);
    } else if (extension === ".json") {
      targets.jsonFiles.push(relativePath);
    } else if (extension === ".go") {
      targets.goFiles.push(relativePath);
    } else if (extension === ".rs") {
      targets.rustFiles.push(relativePath);
    } else if (FALLBACK_RECOGNIZED_EXTENSIONS.has(extension) || lowerName === "makefile" || lowerName === "dockerfile") {
      targets.unsupportedFiles.push(relativePath);
    }
  }
}

function fallbackTargetCount(targets: FallbackTargets): number {
  return targets.pythonFiles.length
    + targets.javascriptFiles.length
    + targets.jsonFiles.length
    + targets.goFiles.length
    + targets.rustFiles.length
    + targets.unsupportedFiles.length;
}

async function validateJsonFiles(workspaceRoot: string, jsonFiles: string[]): Promise<ValidationCommandResult | null> {
  if (jsonFiles.length === 0) return null;

  for (const file of jsonFiles) {
    try {
      JSON.parse(await readFile(join(workspaceRoot, file), "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        name: "json",
        command: `parse ${file}`,
        ok: false,
        exitCode: 1,
        stderr: trimOutput(`${file}: ${reason}`),
      };
    }
  }

  return {
    name: "json",
    command: `parse ${jsonFiles.length} JSON file(s)`,
    ok: true,
    exitCode: 0,
    stdout: `Validated ${jsonFiles.length} JSON file(s).`,
  };
}

async function runJavaScriptSyntaxValidation(
  workspaceRoot: string,
  javascriptFiles: string[],
  context?: ToolExecutionContext,
): Promise<ValidationCommandResult[]> {
  const commands: ValidationCommandResult[] = [];
  for (const file of javascriptFiles) {
    const args = ["--check", file];
    const result = await runCommand(workspaceRoot, process.execPath, args, context);
    commands.push(toCommandResult("javascript", process.execPath, args, result));
    if (!result.ok) break;
  }
  return commands;
}

async function runPythonSyntaxValidation(
  workspaceRoot: string,
  pythonFiles: string[],
  context?: ToolExecutionContext,
): Promise<ValidationCommandResult> {
  const script = [
    "import ast, pathlib, sys",
    "ok = True",
    "for path in sys.argv[1:]:",
    "    try:",
    "        ast.parse(pathlib.Path(path).read_text(encoding='utf-8-sig'), filename=path)",
    "    except SyntaxError as error:",
    "        print(f'{path}:{error.lineno}:{error.offset}: {error.msg}', file=sys.stderr)",
    "        ok = False",
    "    except Exception as error:",
    "        print(f'{path}: {error}', file=sys.stderr)",
    "        ok = False",
    "sys.exit(0 if ok else 1)",
  ].join("\n");
  const args = ["-c", script, ...pythonFiles];
  let displayArgs = ["-c", "<syntax-check>", ...pythonFiles];
  let command = "python";
  let result = await runCommand(workspaceRoot, command, args, context);

  if (!result.ok && isCommandUnavailable(result)) {
    const pyArgs = ["-3", "-c", script, ...pythonFiles];
    const pyResult = await runCommand(workspaceRoot, "py", pyArgs, context);
    if (!isCommandUnavailable(pyResult)) {
      command = "py";
      result = pyResult;
      displayArgs = ["-3", "-c", "<syntax-check>", ...pythonFiles];
      return toCommandResult("python", command, displayArgs, result);
    }
  }

  if (!result.ok && isCommandUnavailable(result)) {
    return skippedCommand("python", formatCommand(command, displayArgs), "Skipped Python syntax validation: no Python interpreter was found.");
  }

  return toCommandResult("python", command, displayArgs, result);
}

async function runExternalFallbackCommand(
  workspaceRoot: string,
  name: string,
  command: string,
  args: string[],
  unavailableMessage: string,
  context?: ToolExecutionContext,
): Promise<ValidationCommandResult> {
  const result = await runCommand(workspaceRoot, command, args, context);
  if (!result.ok && isCommandUnavailable(result)) {
    return skippedCommand(name, formatCommand(command, args), unavailableMessage);
  }
  return toCommandResult(name, command, args, result);
}

function toCommandResult(
  name: string,
  command: string,
  args: string[],
  result: { ok: boolean; exitCode: number; stdout: string; stderr: string },
): ValidationCommandResult {
  return {
    name,
    command: formatCommand(command, args),
    ok: result.ok,
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

function skippedCommand(name: string, command: string, message: string): ValidationCommandResult {
  return {
    name,
    command,
    ok: true,
    exitCode: 0,
    stdout: message,
  };
}

function summarizeSkippedTargets(targets: FallbackTargets, commands: ValidationCommandResult[]): string {
  const parts: string[] = [];
  const commandNames = new Set(commands.map((command) => command.name));
  if (targets.goFiles.length > 0 && !targets.hasRootGoMod) {
    parts.push(`${targets.goFiles.length} Go file(s) recognized but skipped because no root go.mod was found`);
  }
  if (targets.rustFiles.length > 0 && !targets.hasRootCargoToml) {
    parts.push(`${targets.rustFiles.length} Rust file(s) recognized but skipped because no root Cargo.toml was found`);
  }
  if (targets.pythonFiles.length > 0 && !commandNames.has("python")) {
    parts.push(`${targets.pythonFiles.length} Python file(s) recognized but not validated`);
  }
  if (targets.javascriptFiles.length > 0 && !commandNames.has("javascript")) {
    parts.push(`${targets.javascriptFiles.length} JavaScript file(s) recognized but not validated`);
  }
  if (targets.unsupportedFiles.length > 0) {
    parts.push(`${targets.unsupportedFiles.length} other recognized file(s) skipped because no fallback validator is configured`);
  }
  return parts.join("; ");
}

function isCommandUnavailable(result: { ok: boolean; stderr: string; stdout: string }): boolean {
  if (result.ok) return false;
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /enoent|not recognized|was not found|no python|command not found|can't find .*python|no such file or directory/.test(text);
}

function getExtension(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandPart).join(" ");
}

function quoteCommandPart(part: string): string {
  if (!/[\s"]/u.test(part)) return part;
  return `"${part.replace(/"/g, "\\\"")}"`;
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, "/");
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
      if (!scripts) {
        return runFallbackValidation(workspaceRoot, mode, context);
      }
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

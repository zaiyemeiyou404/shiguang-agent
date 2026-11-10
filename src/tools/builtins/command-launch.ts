import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";

const SHELL_SYNTAX_CHARS = new Set(["\n", "\r", "|", "&", ";", "<", ">", "`"]);
const SHELL_HOSTS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
  "wsl",
  "wsl.exe",
]);
const ABSOLUTE_PATH = /[a-zA-Z]:[\\/][^\s"'`]{0,260}|\\\\[^\s"'`]{1,260}/g;

export interface ParsedCommand {
  file: string;
  args: string[];
}

export interface SpawnParsedCommandOptions {
  cwd: string;
  allowShellHost?: boolean;
}

export function parseCommandArguments(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Command is empty.");
  if (hasShellSyntax(trimmed)) {
    throw new Error("Shell operators, pipes, redirection, and command substitution are not allowed. Run one executable with arguments.");
  }
  const tokens = tokenizeCommand(trimmed);
  const file = tokens[0];
  if (!file) throw new Error("Command is empty.");
  return { file, args: tokens.slice(1) };
}

export function isShellHostExecutable(file: string): boolean {
  return SHELL_HOSTS.has(basename(file).toLowerCase());
}

export function pathsOutsideWorkspace(workspaceRoot: string, cwd: string, args: readonly string[]): string[] {
  const outside: string[] = [];
  if (!isInsideWorkspace(workspaceRoot, cwd)) outside.push(cwd);
  for (const arg of args) {
    const matches = arg.match(ABSOLUTE_PATH) ?? [];
    for (const match of matches) {
      const cleaned = match.replace(/[),.;]+$/g, "");
      if (!isInsideWorkspace(workspaceRoot, cleaned)) outside.push(cleaned);
    }
  }
  return outside;
}

export function spawnParsedCommand(command: string, options: SpawnParsedCommandOptions): ChildProcess {
  const parsed = parseCommandArguments(command);
  if (isShellHostExecutable(parsed.file) && !options.allowShellHost) {
    throw new Error(`Shell host ${basename(parsed.file)} is only available with the full_access execution preset. Run the target executable directly.`);
  }
  const executable = resolveExecutable(parsed.file, options.cwd);
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
    const commandLine = `"${[executable, ...parsed.args].map(quoteCmdArgument).join(" ")}"`;
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(executable, parsed.args, {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasShellSyntax(input: string): boolean {
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (!ch) continue;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (SHELL_SYNTAX_CHARS.has(ch)) return true;
    if (ch === "$" && input[index + 1] === "(") return true;
  }
  return false;
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("Command has an unterminated quote.");
  if (current) tokens.push(current);
  return tokens;
}

function resolveExecutable(file: string, cwd: string): string {
  if (isAbsolute(file) || file.includes("/") || file.includes("\\")) {
    const candidate = isAbsolute(file) ? file : resolve(cwd, file);
    const resolved = existingExecutable(candidate);
    if (!resolved) throw new Error(`Executable not found: ${file}`);
    return resolved;
  }

  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const suffix = extension && !file.toLowerCase().endsWith(extension.toLowerCase()) ? extension : "";
      const candidate = join(directory, `${file}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Executable not found: ${file}. Shell builtins such as dir, echo, and type are not available.`);
}

function existingExecutable(candidate: string): string | null {
  if (existsSync(candidate)) return candidate;
  if (process.platform !== "win32") return null;
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const extension of extensions) {
    if (candidate.toLowerCase().endsWith(extension.toLowerCase())) continue;
    const withExtension = `${candidate}${extension}`;
    if (existsSync(withExtension)) return withExtension;
  }
  return null;
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) return "\"\"";
  if (!/[\s"&|<>^%]/.test(value)) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function isInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith("/") && !rel.startsWith("\\"));
}

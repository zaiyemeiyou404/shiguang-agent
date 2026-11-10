import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type TerminalTool = {
  descriptor: {
    name: string;
    description: string;
    effects?: {
      validationMode?: string;
    };
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown, context?: { signal?: AbortSignal; executionGrant?: { preset: "full_access"; allowRead: true; allowWrite: true; allowExecute: true; allowNetwork: true; allowHostExecute: true } }): Promise<unknown>;
};

type TerminalModule = {
  createRunTerminalCommandTool(workspaceRoot: string): TerminalTool;
};

type TerminalOutput = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cwd: string;
};

async function loadModule(): Promise<TerminalModule> {
  return import("./run-terminal-command.js") as Promise<TerminalModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "run-terminal-command-"));
}

function assertOutput(value: unknown): asserts value is TerminalOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<TerminalOutput>;
  assert.equal(typeof output.ok, "boolean");
  assert.equal(typeof output.exitCode, "number");
  assert.equal(typeof output.stdout, "string");
  assert.equal(typeof output.stderr, "string");
  assert.equal(typeof output.timedOut, "boolean");
  assert.equal(typeof output.cwd, "string");
}

function quoteCommandArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value;
}

test("run_terminal_command executes a workspace command", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.match(tool.descriptor.description, /not a filesystem sandbox/i);

  assert.equal(tool.descriptor.name, "run_terminal_command");
  assert.equal(tool.descriptor.effects?.validationMode, "all");
  assert.equal(tool.descriptor.risk, "execute");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "process.exec");

  const result = await tool.execute({ command: `${quoteCommandArg(process.execPath)} -e "console.log('hello from tool')"` });
  assertOutput(result);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello from tool/);
});

test("run_terminal_command rejects commands outside the workspace unless host execution is granted", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const outsideRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);
  const outsideCwd = join(dirname(outsideRoot), basename(outsideRoot));

  await assert.rejects(
    () => tool.execute({ command: `${quoteCommandArg(process.execPath)} -e "console.log('outside')"`, cwd: outsideCwd }),
    /does not allow host execution/i,
  );

  const result = await tool.execute(
    { command: `${quoteCommandArg(process.execPath)} -e "console.log('outside')"`, cwd: outsideCwd },
    { executionGrant: { preset: "full_access", allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true, allowHostExecute: true } },
  );
  assertOutput(result);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /outside/);
});

test("run_terminal_command rejects shell syntax and shell hosts", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ command: `${quoteCommandArg(process.execPath)} -e "console.log(1)" > out.txt` }),
    /shell operators/i,
  );
  await assert.rejects(
    () => tool.execute({ command: "cmd /c echo no" }),
    /Shell host/i,
  );
});

test("run_terminal_command rejects mutating commands outside the workspace", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const outsideRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ command: `${quoteCommandArg(process.execPath)} -e "require('fs').writeFileSync('x.txt','x')"`, cwd: outsideRoot }),
    /does not allow host execution/i,
  );
});

test("run_terminal_command rejects a Windows absolute cwd on another drive", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows drive-letter behavior");
    return;
  }
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const currentDrive = workspaceRoot.slice(0, 1).toUpperCase();
  const otherDrive = currentDrive === "Z" ? "Y" : "Z";

  await assert.rejects(
    () => createRunTerminalCommandTool(workspaceRoot).execute({ command: "echo no", cwd: `${otherDrive}:\\outside` }),
    /does not allow host execution/i,
  );
});

test("run_terminal_command reports timeout state", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  const result = await tool.execute({ command: `${quoteCommandArg(process.execPath)} -e "setTimeout(() => console.log('late'), 200)"`, timeoutMs: 20 });
  assertOutput(result);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
});

test("run_terminal_command aborts an in-flight process", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);
  const controller = new AbortController();

  const pending = tool.execute(
    { command: `${quoteCommandArg(process.execPath)} -e "setTimeout(() => console.log('late'), 500)"` },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof DOMException, true);
    assert.equal((error as DOMException).name, "AbortError");
    return true;
  });
});

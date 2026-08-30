import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type TerminalTool = {
  descriptor: {
    name: string;
    effects?: {
      validationMode?: string;
    };
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown, context?: { signal?: AbortSignal }): Promise<unknown>;
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

test("run_terminal_command executes a workspace command", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "run_terminal_command");
  assert.equal(tool.descriptor.effects?.validationMode, "all");
  assert.equal(tool.descriptor.risk, "execute");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "process.exec");

  const result = await tool.execute({ command: `${process.execPath} -e "console.log('hello from tool')"` });
  assertOutput(result);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello from tool/);
});

test("run_terminal_command allows obvious read-only commands outside the workspace", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const outsideRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  const result = await tool.execute({ command: "dir", cwd: join(dirname(outsideRoot), basename(outsideRoot)) });
  assertOutput(result);
  assert.equal(result.ok, true);
  assert.match(result.cwd.replace(/\\/g, "/"), new RegExp(`${basename(outsideRoot)}$`));
});

test("run_terminal_command rejects mutating commands outside the workspace", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const outsideRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ command: `${process.execPath} -e "require('fs').writeFileSync('x.txt','x')"`, cwd: outsideRoot }),
    /escapes workspace root/i,
  );
});

test("run_terminal_command reports timeout state", async () => {
  const { createRunTerminalCommandTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createRunTerminalCommandTool(workspaceRoot);

  const result = await tool.execute({ command: `${process.execPath} -e "setTimeout(() => console.log('late'), 200)"`, timeoutMs: 20 });
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
    { command: `${process.execPath} -e "setTimeout(() => console.log('late'), 500)"` },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof DOMException, true);
    assert.equal((error as DOMException).name, "AbortError");
    return true;
  });
});

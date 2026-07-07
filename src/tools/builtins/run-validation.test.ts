import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type RunValidationTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type RunValidationModule = {
  createRunValidationTool(workspaceRoot: string): RunValidationTool;
};

type ValidationCommandResult = {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type ValidationOutput = {
  ok: boolean;
  mode: string;
  commands: ValidationCommandResult[];
};

async function loadRunValidationModule(): Promise<RunValidationModule> {
  const modulePath = "./run-validation.js";
  return import(modulePath) as Promise<RunValidationModule>;
}

async function makeWorkspace(scripts: Record<string, string>): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "run-validation-"));
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "validation-fixture", private: true, scripts }, null, 2),
  );
  return workspaceRoot;
}

function recordCommandScript(name: string, exitCode = 0): string {
  return `node -e "require('fs').appendFileSync('commands.log', ${JSON.stringify(`${name}\\n`)}); process.exit(${exitCode})"`;
}

function noisyCommandScript(name: string, stdout: string, stderr: string, exitCode = 1): string {
  return `node -e "process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); require('fs').appendFileSync('commands.log', ${JSON.stringify(`${name}\\n`)}); process.exit(${exitCode})"`;
}

async function readCommands(workspaceRoot: string): Promise<string[]> {
  try {
    const content = await readFile(join(workspaceRoot, "commands.log"), "utf8");
    return content.trim().length === 0 ? [] : content.trim().split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function assertValidationOutput(value: unknown): asserts value is ValidationOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<ValidationOutput>;
  assert.equal(typeof output.ok, "boolean");
  assert.equal(typeof output.mode, "string");
  assert.ok(Array.isArray(output.commands));
}

async function assertRejectsWithValidationMessage(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /validation/i);
      return true;
    },
  );
}

test("run_validation runs the typecheck script and reports success", async () => {
  const { createRunValidationTool } = await loadRunValidationModule();
  const workspaceRoot = await makeWorkspace({
    typecheck: recordCommandScript("typecheck"),
  });
  const tool = createRunValidationTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "run_validation");
  assert.equal(tool.descriptor.risk, "execute");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "process.validate");

  const result = await tool.execute("typecheck");

  assertValidationOutput(result);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "typecheck");
  assert.deepEqual(result.commands, [
    {
      name: "typecheck",
      command: "npm run typecheck",
      ok: true,
      exitCode: 0,
    },
  ]);
  assert.deepEqual(await readCommands(workspaceRoot), ["typecheck"]);
});

test("run_validation stops all mode at the first failing command", async () => {
  const { createRunValidationTool } = await loadRunValidationModule();
  const workspaceRoot = await makeWorkspace({
    typecheck: recordCommandScript("typecheck"),
    test: noisyCommandScript("test", "stdout: missing semicolon\n", "stderr: src/app.ts:1:1 type error\n", 7),
    build: recordCommandScript("build"),
  });
  const tool = createRunValidationTool(workspaceRoot);

  const result = await tool.execute({ mode: "all" });

  assertValidationOutput(result);
  assert.equal(result.ok, false);
  assert.equal(result.mode, "all");
  assert.deepEqual(
    result.commands.map(command => ({
      name: command.name,
      command: command.command,
      ok: command.ok,
      exitCode: command.exitCode,
    })),
    [
      { name: "typecheck", command: "npm run typecheck", ok: true, exitCode: 0 },
      { name: "test", command: "npm run test", ok: false, exitCode: 7 },
    ],
  );
  assert.match(result.commands[1]?.stdout ?? "", /missing semicolon/);
  assert.match(result.commands[1]?.stderr ?? "", /type error/);
  assert.deepEqual(await readCommands(workspaceRoot), ["typecheck", "test"]);
});

test("run_validation rejects unsupported validation modes with a clear error", async () => {
  const { createRunValidationTool } = await loadRunValidationModule();
  const workspaceRoot = await makeWorkspace({
    typecheck: recordCommandScript("typecheck"),
  });
  const tool = createRunValidationTool(workspaceRoot);

  await assertRejectsWithValidationMessage(() => tool.execute({ mode: "lint" }));
});

test("run_validation rejects unavailable validation scripts with a clear error", async () => {
  const { createRunValidationTool } = await loadRunValidationModule();
  const workspaceRoot = await makeWorkspace({
    typecheck: recordCommandScript("typecheck"),
  });
  const tool = createRunValidationTool(workspaceRoot);

  await assertRejectsWithValidationMessage(() => tool.execute("build"));
});

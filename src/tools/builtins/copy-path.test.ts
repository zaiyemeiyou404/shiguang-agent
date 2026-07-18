import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type CopyPathTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type CopyPathModule = {
  createCopyPathTool(workspaceRoot: string): CopyPathTool;
};

type CopyPathOutput = {
  sourcePath: string;
  destinationPath: string;
  bytes: number;
};

async function loadModule(): Promise<CopyPathModule> {
  return import("./copy-path.js") as Promise<CopyPathModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "copy-path-"));
}

function assertOutput(value: unknown): asserts value is CopyPathOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<CopyPathOutput>;
  assert.equal(typeof output.sourcePath, "string");
  assert.equal(typeof output.destinationPath, "string");
  assert.equal(typeof output.bytes, "number");
}

test("copy_path copies a workspace file into another workspace path", async () => {
  const { createCopyPathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "console.log('hi');\n", "utf8");
  const tool = createCopyPathTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "copy_path");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "fs.copy");

  const result = await tool.execute({ sourcePath: "src/app.ts", destinationPath: "backup/app.ts" });
  assertOutput(result);
  assert.match(result.destinationPath, /backup\/app\.ts$/);
  assert.equal(await readFile(join(workspaceRoot, "backup", "app.ts"), "utf8"), "console.log('hi');\n");
});

test("copy_path rejects destination paths outside the workspace root", async () => {
  const { createCopyPathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await writeFile(join(workspaceRoot, "file.txt"), "hello\n", "utf8");
  const tool = createCopyPathTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ sourcePath: "file.txt", destinationPath: "../outside.txt" }),
    /workspace root/i,
  );
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type ReadManyFilesTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type ReadManyFilesModule = {
  createReadManyFilesTool(workspaceRoot: string): ReadManyFilesTool;
};

type ReadManyFilesOutput = {
  files: Array<{ path: string; content: string; ok: boolean; error?: string }>;
  totalFiles: number;
  failed: number;
};

async function loadModule(): Promise<ReadManyFilesModule> {
  return import("./read-many-files.js") as Promise<ReadManyFilesModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "read-many-files-"));
}

function assertOutput(value: unknown): asserts value is ReadManyFilesOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<ReadManyFilesOutput>;
  assert.equal(Array.isArray(output.files), true);
  assert.equal(typeof output.totalFiles, "number");
  assert.equal(typeof output.failed, "number");
}

test("read_many_files reads several workspace files in one call", async () => {
  const { createReadManyFilesTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "main.ts"), "export const ok = true;\n", "utf8");
  const tool = createReadManyFilesTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "read_many_files");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.read_many");

  const result = await tool.execute({ paths: ["README.md", "src/main.ts"] });

  assertOutput(result);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.failed, 0);
  assert.match(result.files[0]?.content ?? "", /Demo/);
  assert.match(result.files[1]?.content ?? "", /ok = true/);
});

test("read_many_files reports path errors without aborting the batch", async () => {
  const { createReadManyFilesTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await writeFile(join(workspaceRoot, "safe.txt"), "safe\n", "utf8");
  const tool = createReadManyFilesTool(workspaceRoot);

  const result = await tool.execute({ paths: ["safe.txt", "../outside.txt"] });

  assertOutput(result);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.files[0]?.ok, true);
  assert.equal(result.files[1]?.ok, false);
  assert.match(result.files[1]?.error ?? "", /workspace root/i);
});

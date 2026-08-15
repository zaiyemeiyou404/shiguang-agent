import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type ReadTextFileTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type ReadTextFileModule = {
  createReadTextFileTool(workspaceRoot: string): ReadTextFileTool;
};

type ReadTextFileOutput = {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
};

async function loadModule(): Promise<ReadTextFileModule> {
  return import("./read-text-file.js") as Promise<ReadTextFileModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "read-text-file-"));
}

function assertOutput(value: unknown): asserts value is ReadTextFileOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<ReadTextFileOutput>;
  assert.equal(typeof output.path, "string");
  assert.equal(typeof output.content, "string");
  assert.equal(typeof output.truncated, "boolean");
  assert.equal(typeof output.bytes, "number");
}

test("read_text_file reads a workspace file and exposes safe metadata", async () => {
  const { createReadTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const filePath = join(workspaceRoot, "example.ts");
  await writeFile(filePath, "const answer = 42;\n", "utf8");
  const tool = createReadTextFileTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "read_text_file");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.read");

  const result = await tool.execute({ path: "example.ts" });
  assertOutput(result);
  assert.match(result.path, /example\.ts$/);
  assert.equal(result.content, "const answer = 42;\n");
  assert.equal(result.truncated, false);
});

test("read_text_file rejects paths that escape the workspace root", async () => {
  const { createReadTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createReadTextFileTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "../outside.ts" }),
    /workspace root/i,
  );
});

test("read_text_file strips a repeated workspace directory prefix when the corrected file exists", async () => {
  const { createReadTextFileTool } = await loadModule();
  const parent = await makeWorkspace();
  const workspaceRoot = join(parent, "worktest");
  await mkdir(join(workspaceRoot, "traintime_pda-main"), { recursive: true });
  await writeFile(join(workspaceRoot, "traintime_pda-main", "pubspec.yaml"), "name: watermeter\n", "utf8");
  const tool = createReadTextFileTool(workspaceRoot);

  const result = await tool.execute({ path: "worktest/traintime_pda-main/pubspec.yaml" });

  assertOutput(result);
  assert.match(result.path, /traintime_pda-main[\\/]pubspec\.yaml$/);
  assert.equal(result.content, "name: watermeter\n");
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type WriteTextFileTool = {
  descriptor: {
    name: string;
    effects?: {
      workspaceMutation?: boolean;
      validationMode?: string;
    };
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type WriteTextFileModule = {
  createWriteTextFileTool(workspaceRoot: string): WriteTextFileTool;
};

type WriteTextFileOutput = {
  path: string;
  bytes: number;
};

async function loadModule(): Promise<WriteTextFileModule> {
  return import("./write-text-file.js") as Promise<WriteTextFileModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "write-text-file-"));
}

function assertOutput(value: unknown): asserts value is WriteTextFileOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<WriteTextFileOutput>;
  assert.equal(typeof output.path, "string");
  assert.equal(typeof output.bytes, "number");
}

test("write_text_file overwrites a workspace file and marks mutation effects", async () => {
  const { createWriteTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await writeFile(join(workspaceRoot, "example.ts"), "const before = 1;\n");
  const tool = createWriteTextFileTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "write_text_file");
  assert.equal(tool.descriptor.effects?.workspaceMutation, true);
  assert.equal(tool.descriptor.effects?.validationMode, "all");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "fs.write");

  const result = await tool.execute({ path: "example.ts", content: "const after = 2;\n" });

  assertOutput(result);
  assert.match(result.path, /example\.ts$/);
  assert.equal(await readFile(join(workspaceRoot, "example.ts"), "utf8"), "const after = 2;\n");
  assert.equal(result.bytes, Buffer.byteLength("const after = 2;\n"));
});

test("write_text_file rejects paths that escape the workspace root", async () => {
  const { createWriteTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createWriteTextFileTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "../outside.ts", content: "nope\n" }),
    /workspace root/i,
  );
});

test("write_text_file requires both path and content", async () => {
  const { createWriteTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createWriteTextFileTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "example.ts" }),
    /path and content/i,
  );
});

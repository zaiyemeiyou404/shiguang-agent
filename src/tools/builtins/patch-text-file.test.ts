import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type PatchTool = {
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
  previewApproval?(input: unknown): Promise<unknown> | unknown;
  execute(input: unknown): Promise<unknown>;
};

type PatchModule = {
  createPatchTextFileTool(workspaceRoot: string): PatchTool;
};

type PatchOutput = {
  path: string;
  replacements: number;
  bytes: number;
};

async function loadModule(): Promise<PatchModule> {
  return import("./patch-text-file.js") as Promise<PatchModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "patch-text-file-"));
}

function assertOutput(value: unknown): asserts value is PatchOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<PatchOutput>;
  assert.equal(typeof output.path, "string");
  assert.equal(typeof output.replacements, "number");
  assert.equal(typeof output.bytes, "number");
}

test("patch_text_file replaces one exact match", async () => {
  const { createPatchTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const filePath = join(workspaceRoot, "example.ts");
  await writeFile(filePath, "const value = 1;\n", "utf8");
  const tool = createPatchTextFileTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "patch_text_file");
  assert.equal(tool.descriptor.effects?.workspaceMutation, true);
  assert.equal(tool.descriptor.effects?.validationMode, "all");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "fs.patch");

  const result = await tool.execute({
    path: "example.ts",
    oldString: "const value = 1;",
    newString: "const value = 2;",
  });

  assertOutput(result);
  assert.equal(result.replacements, 1);
  assert.equal(await readFile(filePath, "utf8"), "const value = 2;\n");
});

test("patch_text_file requires replaceAll for multiple matches", async () => {
  const { createPatchTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const filePath = join(workspaceRoot, "example.ts");
  await writeFile(filePath, "x\nx\n", "utf8");
  const tool = createPatchTextFileTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "example.ts", oldString: "x", newString: "y" }),
    /replace all/i,
  );

  const result = await tool.execute({ path: "example.ts", oldString: "x", newString: "y", replaceAll: true });
  assertOutput(result);
  assert.equal(result.replacements, 2);
  assert.equal(await readFile(filePath, "utf8"), "y\ny\n");
});

test("patch_text_file approval preview includes the proposed patch", async () => {
  const { createPatchTextFileTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const filePath = join(workspaceRoot, "example.ts");
  await writeFile(filePath, "const value = 1;\n", "utf8");
  const tool = createPatchTextFileTool(workspaceRoot);

  const preview = await tool.previewApproval?.({
    path: "example.ts",
    oldString: "const value = 1;",
    newString: "const value = 2;",
  });

  assert.equal(typeof preview, "object");
  assert.notEqual(preview, null);
  const payload = preview as { kind?: string; diff?: string; additions?: number; deletions?: number };
  assert.equal(payload.kind, "text_diff");
  assert.match(payload.diff ?? "", /-const value = 1;/);
  assert.match(payload.diff ?? "", /\+const value = 2;/);
  assert.equal(payload.additions, 1);
  assert.equal(payload.deletions, 1);
});

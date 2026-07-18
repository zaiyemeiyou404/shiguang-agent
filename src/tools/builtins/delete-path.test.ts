import { mkdtemp, mkdir, access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type DeletePathTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type DeletePathModule = {
  createDeletePathTool(workspaceRoot: string): DeletePathTool;
};

type DeletePathOutput = {
  path: string;
  kind: "file" | "directory";
};

async function loadModule(): Promise<DeletePathModule> {
  return import("./delete-path.js") as Promise<DeletePathModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "delete-path-"));
}

function assertOutput(value: unknown): asserts value is DeletePathOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<DeletePathOutput>;
  assert.equal(typeof output.path, "string");
  assert.ok(output.kind === "file" || output.kind === "directory");
}

test("delete_path deletes a workspace file", async () => {
  const { createDeletePathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await writeFile(join(workspaceRoot, "note.txt"), "bye\n", "utf8");
  const tool = createDeletePathTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "delete_path");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "fs.delete");

  const result = await tool.execute({ path: "note.txt" });
  assertOutput(result);
  await assert.rejects(() => access(join(workspaceRoot, "note.txt"), constants.F_OK));
});

test("delete_path requires recursive for directories", async () => {
  const { createDeletePathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "logs"), { recursive: true });
  const tool = createDeletePathTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "logs" }),
    /recursive/i,
  );
});

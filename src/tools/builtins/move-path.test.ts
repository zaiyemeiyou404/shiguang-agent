import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type MovePathTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type MovePathModule = {
  createMovePathTool(workspaceRoot: string): MovePathTool;
};

type MovePathOutput = {
  sourcePath: string;
  destinationPath: string;
  bytes: number;
};

async function loadModule(): Promise<MovePathModule> {
  return import("./move-path.js") as Promise<MovePathModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "move-path-"));
}

function assertOutput(value: unknown): asserts value is MovePathOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<MovePathOutput>;
  assert.equal(typeof output.sourcePath, "string");
  assert.equal(typeof output.destinationPath, "string");
  assert.equal(typeof output.bytes, "number");
}

test("move_path renames a workspace file into another workspace path", async () => {
  const { createMovePathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "console.log('hi');\n", "utf8");
  const tool = createMovePathTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "move_path");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "fs.move");

  const result = await tool.execute({ sourcePath: "src/app.ts", destinationPath: "renamed/app.ts" });
  assertOutput(result);
  assert.match(result.destinationPath, /renamed\/app\.ts$/);
  assert.equal(await readFile(join(workspaceRoot, "renamed", "app.ts"), "utf8"), "console.log('hi');\n");
});

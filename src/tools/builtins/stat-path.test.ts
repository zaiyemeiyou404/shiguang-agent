import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type StatPathTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type StatPathModule = {
  createStatPathTool(workspaceRoot: string): StatPathTool;
};

type StatPathOutput = {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
};

async function loadModule(): Promise<StatPathModule> {
  return import("./stat-path.js") as Promise<StatPathModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "stat-path-"));
}

function assertOutput(value: unknown): asserts value is StatPathOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<StatPathOutput>;
  assert.equal(typeof output.path, "string");
  assert.equal(typeof output.name, "string");
  assert.ok(output.kind === "file" || output.kind === "directory");
  assert.equal(typeof output.size, "number");
}

test("stat_path returns metadata for a workspace file", async () => {
  const { createStatPathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const x = 1;\n", "utf8");
  const tool = createStatPathTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "stat_path");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.stat");

  const result = await tool.execute({ path: "src/app.ts" });
  assertOutput(result);
  assert.match(result.path, /src\/app\.ts$/);
  assert.equal(result.name, "app.ts");
  assert.equal(result.kind, "file");
  assert.ok(result.size > 0);
});

test("stat_path rejects missing files with a clear error", async () => {
  const { createStatPathTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createStatPathTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "missing.txt" }),
    /not found|not readable/i,
  );
});

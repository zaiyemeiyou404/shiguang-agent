import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type ListDirectoryTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type ListDirectoryModule = {
  createListDirectoryTool(workspaceRoot: string): ListDirectoryTool;
};

type ListDirectoryOutput = {
  path: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
    size: number;
  }>;
};

async function loadModule(): Promise<ListDirectoryModule> {
  return import("./list-directory.js") as Promise<ListDirectoryModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "list-directory-"));
}

function assertOutput(value: unknown): asserts value is ListDirectoryOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<ListDirectoryOutput>;
  assert.equal(typeof output.path, "string");
  assert.ok(Array.isArray(output.entries));
}

test("list_directory lists workspace entries with basic metadata", async () => {
  const { createListDirectoryTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "hello\n", "utf8");
  const tool = createListDirectoryTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "list_directory");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.list");

  const result = await tool.execute({ path: "." });
  assertOutput(result);
  assert.deepEqual(
    result.entries.map((entry) => ({ name: entry.name, kind: entry.kind })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "README.md", kind: "file" },
      { name: "src", kind: "directory" },
    ],
  );
});

test("list_directory rejects escaping the workspace root", async () => {
  const { createListDirectoryTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createListDirectoryTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ path: "../outside" }),
    /workspace root/i,
  );
});

test("list_directory strips a repeated workspace directory prefix when the corrected path exists", async () => {
  const { createListDirectoryTool } = await loadModule();
  const parent = await makeWorkspace();
  const workspaceRoot = join(parent, "worktest");
  await mkdir(join(workspaceRoot, "traintime_pda-main", "lib"), { recursive: true });
  const tool = createListDirectoryTool(workspaceRoot);

  const result = await tool.execute({ path: "worktest/traintime_pda-main" });

  assertOutput(result);
  assert.match(result.path, /traintime_pda-main$/);
  assert.deepEqual(
    result.entries.map((entry) => ({ name: entry.name, kind: entry.kind })),
    [{ name: "lib", kind: "directory" }],
  );
});

test("list_directory strips a repeated workspace prefix from absolute paths", async () => {
  const { createListDirectoryTool } = await loadModule();
  const parent = await makeWorkspace();
  const workspaceRoot = join(parent, "worktest");
  await mkdir(join(workspaceRoot, "traintime_pda-main", "lib"), { recursive: true });
  const tool = createListDirectoryTool(workspaceRoot);

  const result = await tool.execute({ path: join(workspaceRoot, "worktest", "traintime_pda-main") });

  assertOutput(result);
  assert.match(result.path, /traintime_pda-main$/);
  assert.deepEqual(
    result.entries.map((entry) => ({ name: entry.name, kind: entry.kind })),
    [{ name: "lib", kind: "directory" }],
  );
});

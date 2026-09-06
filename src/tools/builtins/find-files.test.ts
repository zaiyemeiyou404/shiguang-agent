import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type FindFilesTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type FindFilesModule = {
  createFindFilesTool(workspaceRoot: string): FindFilesTool;
};

type FindFilesOutput = {
  results: Array<{ path: string; kind: "file" | "directory"; score: number }>;
  scanned: number;
  truncated: boolean;
};

async function loadModule(): Promise<FindFilesModule> {
  return import("./find-files.js") as Promise<FindFilesModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "find-files-"));
}

function assertOutput(value: unknown): asserts value is FindFilesOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<FindFilesOutput>;
  assert.equal(Array.isArray(output.results), true);
  assert.equal(typeof output.scanned, "number");
  assert.equal(typeof output.truncated, "boolean");
}

test("find_files locates files by filename fragment", async () => {
  const { createFindFilesTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "main.dart"), "void main() {}\n", "utf8");
  const tool = createFindFilesTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "find_files");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.find");

  const result = await tool.execute({ query: "main.dart" });

  assertOutput(result);
  assert.equal(result.results[0]?.path, "src/main.dart");
});

test("find_files supports simple glob patterns and skips generated folders", async () => {
  const { createFindFilesTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "main.ts"), "export {}\n", "utf8");
  await writeFile(join(workspaceRoot, "node_modules", "pkg", "ignored.ts"), "export {}\n", "utf8");
  const tool = createFindFilesTool(workspaceRoot);

  const result = await tool.execute({ pattern: "*.ts" });

  assertOutput(result);
  assert.deepEqual(result.results.map((item) => item.path), ["src/main.ts"]);
});

test("find_files rejects search roots outside the workspace", async () => {
  const { createFindFilesTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  const tool = createFindFilesTool(workspaceRoot);

  await assert.rejects(
    () => tool.execute({ query: "secret.txt", path: "../outside" }),
    /workspace root/i,
  );
});

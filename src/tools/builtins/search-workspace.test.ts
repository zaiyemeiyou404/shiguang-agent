import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type SearchWorkspaceTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type SearchWorkspaceModule = {
  createSearchWorkspaceTool(workspaceRoot: string): SearchWorkspaceTool;
};

type SearchWorkspaceOutput = {
  query: string;
  results: Array<{ file: string; line: number; snippet: string }>;
  truncated: boolean;
  filesScanned: number;
};

async function loadModule(): Promise<SearchWorkspaceModule> {
  return import("./search-workspace.js") as Promise<SearchWorkspaceModule>;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "search-workspace-"));
}

function assertOutput(value: unknown): asserts value is SearchWorkspaceOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<SearchWorkspaceOutput>;
  assert.equal(typeof output.query, "string");
  assert.ok(Array.isArray(output.results));
  assert.equal(typeof output.truncated, "boolean");
  assert.equal(typeof output.filesScanned, "number");
}

test("search_workspace finds text matches and exposes read-only metadata", async () => {
  const { createSearchWorkspaceTool } = await loadModule();
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "const magicToken = 'alpha';\n", "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "MagicToken appears here too\n", "utf8");
  const tool = createSearchWorkspaceTool(workspaceRoot);

  assert.equal(tool.descriptor.name, "search_workspace");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "fs.search");

  const result = await tool.execute({ query: "magictoken" });
  assertOutput(result);
  assert.equal(result.query, "magictoken");
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((entry) => entry.file).sort(), ["README.md", "src/app.ts"]);
  assert.equal(result.truncated, false);
  assert.ok(result.filesScanned >= 2);
});

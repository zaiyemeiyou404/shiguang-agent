import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "git-tools-"));
}

function gitAvailable(): boolean {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

function runGit(workspaceRoot: string, args: string[]): void {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("git_status reads branch and short status", { skip: !gitAvailable() }, async () => {
  const { createGitStatusTool } = await import("./git-status.js");
  const workspaceRoot = await makeWorkspace();
  runGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "README.md"), "hello\n", "utf8");

  const tool = createGitStatusTool(workspaceRoot);
  const result = await tool.execute({});
  const output = result as { ok?: boolean; branch?: string | null; status?: string };

  assert.equal(tool.descriptor.name, "git_status");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(output.ok, true);
  assert.ok(output.branch);
  assert.match(output.status ?? "", /\?\? README\.md/);
});

test("git_diff reads unstaged file diff", { skip: !gitAvailable() }, async () => {
  const { createGitDiffTool } = await import("./git-diff.js");
  const workspaceRoot = await makeWorkspace();
  runGit(workspaceRoot, ["init"]);
  runGit(workspaceRoot, ["config", "user.email", "agent@example.test"]);
  runGit(workspaceRoot, ["config", "user.name", "Agent Test"]);
  await writeFile(join(workspaceRoot, "example.txt"), "before\n", "utf8");
  runGit(workspaceRoot, ["add", "example.txt"]);
  runGit(workspaceRoot, ["commit", "-m", "initial"]);
  await writeFile(join(workspaceRoot, "example.txt"), "after\n", "utf8");

  const tool = createGitDiffTool(workspaceRoot);
  const result = await tool.execute({ path: "example.txt" });
  const output = result as { ok?: boolean; diff?: string; path?: string | null };

  assert.equal(tool.descriptor.name, "git_diff");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(output.ok, true);
  assert.equal(output.path, "example.txt");
  assert.match(output.diff ?? "", /-before/);
  assert.match(output.diff ?? "", /\+after/);
});

test("inspect_project summarizes package scripts and file stats", async () => {
  const { createInspectProjectTool } = await import("./inspect-project.js");
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({
    name: "sample",
    version: "1.0.0",
    scripts: { test: "node --test" },
    dependencies: { react: "^19.0.0" },
    devDependencies: { typescript: "^5.0.0" },
  }, null, 2), "utf8");
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const app = true;\n", "utf8");

  const tool = createInspectProjectTool(workspaceRoot);
  const result = await tool.execute({});
  const output = result as {
    package?: { name?: string | null; scripts?: Record<string, string> } | null;
    detected?: string[];
    fileStats?: { byExtension?: Record<string, number> };
  };

  assert.equal(tool.descriptor.name, "inspect_project");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(output.package?.name, "sample");
  assert.equal(output.package?.scripts?.test, "node --test");
  assert.ok(output.detected?.includes("react"));
  assert.ok(output.detected?.includes("typescript"));
  assert.equal(output.fileStats?.byExtension?.[".ts"], 1);
});

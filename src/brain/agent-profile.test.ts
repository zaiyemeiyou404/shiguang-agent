import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyAgentProfileToolAllowlist,
  formatAgentProfileInstructions,
  loadProjectAgentProfile,
  parseAgentProfile,
} from "./agent-profile.js";
import type { ToolDescriptor } from "../tools/types.js";

test("parseAgentProfile reads frontmatter and instructions", () => {
  const profile = parseAgentProfile(`---
name: coder
description: Project coding profile
model: deepseek-v4-pro
thinking: high
tools: [inspect_project, read_text_file, run_validation]
---
Always inspect before editing.
`, "workspace/.shiguang/agents/coder.md");

  assert.equal(profile.name, "coder");
  assert.equal(profile.description, "Project coding profile");
  assert.equal(profile.model, "deepseek-v4-pro");
  assert.equal(profile.thinking, "high");
  assert.deepEqual(profile.tools, ["inspect_project", "read_text_file", "run_validation"]);
  assert.equal(profile.instructions, "Always inspect before editing.");
});

test("loadProjectAgentProfile loads the default workspace profile", () => {
  const root = mkdtempSync(join(tmpdir(), "shiguang-profile-"));
  try {
    mkdirSync(join(root, ".shiguang", "agents"), { recursive: true });
    writeFileSync(join(root, ".shiguang", "agents", "default.md"), `---
name: default
tools:
  - read_text_file
  - search_workspace
---
Prefer narrow searches.
`, "utf8");

    const profile = loadProjectAgentProfile(root);
    assert.ok(profile);
    assert.equal(profile.name, "default");
    assert.deepEqual(profile.tools, ["read_text_file", "search_workspace"]);
    assert.equal(profile.instructions, "Prefer narrow searches.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyAgentProfileToolAllowlist filters tool descriptors", () => {
  const tools: ToolDescriptor[] = [
    descriptor("read_text_file"),
    descriptor("write_text_file"),
    descriptor("run_validation"),
  ];
  const filtered = applyAgentProfileToolAllowlist(tools, {
    name: "safe",
    tools: ["read_text_file", "run_validation"],
    sourcePath: ".shiguang/agents/safe.md",
    instructions: "Read-only until asked.",
  });

  assert.deepEqual(filtered.map((tool) => tool.name), ["read_text_file", "run_validation"]);
});

test("formatAgentProfileInstructions returns model and tool context", () => {
  const text = formatAgentProfileInstructions({
    name: "reviewer",
    description: "Code review mode",
    model: "deepseek-v4-pro",
    tools: ["read_text_file"],
    sourcePath: ".shiguang/agents/reviewer.md",
    instructions: "Find bugs first.",
  });

  assert.ok(text?.includes("Project agent profile is active."));
  assert.ok(text?.includes("Profile: reviewer"));
  assert.ok(text?.includes("Preferred model: deepseek-v4-pro"));
  assert.ok(text?.includes("Tool allowlist: read_text_file"));
  assert.ok(text?.includes("Find bugs first."));
});

function descriptor(name: string): ToolDescriptor {
  return {
    name,
    description: `${name} tool`,
    inputSchema: {},
  };
}

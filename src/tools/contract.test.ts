import { test } from "node:test";
import * as assert from "node:assert/strict";

import { selectToolsForPlanner } from "../brain/tool-selection.js";
import type { BrainInput } from "../brain/types.js";
import { TOOL_CONTRACT_VERSION, inferToolContract } from "./contract.js";
import { ToolRegistry } from "./registry.js";
import type { ToolDescriptor } from "./types.js";

test("tool contract captures workspace mutation risk and completion guidance", () => {
  const descriptor: ToolDescriptor = {
    name: "write_text_file",
    description: "Write a UTF-8 text file.",
    inputSchema: { type: "object", properties: {} },
    effects: { workspaceMutation: true },
    requiresApproval: true,
    capability: "fs.write",
  };

  const contract = inferToolContract(descriptor);
  assert.equal(contract.version, TOOL_CONTRACT_VERSION);
  assert.equal(contract.category, "filesystem");
  assert.equal(contract.phase, "edit");
  assert.equal(contract.risk, "write");
  assert.equal(contract.approval, "always");
  assert.equal(contract.cost, "high");
  assert.deepEqual(contract.recommendedBeforeTools, ["read_text_file", "search_workspace"]);
  assert.deepEqual(contract.recommendedAfterTools, ["run_validation", "collect_diagnostics"]);
  assert.deepEqual(contract.completionSignals, ["workspace_mutation", "diff_or_written_path"]);
});

test("tool registry returns descriptors with inferred contracts", () => {
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      name: "read_text_file",
      description: "Read a UTF-8 text file.",
      inputSchema: { type: "object", properties: {} },
      requiresApproval: false,
      capability: "fs.read",
    },
    async execute() {
      return { content: "ok" };
    },
  });

  const descriptors = registry.all();
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.contract?.version, TOOL_CONTRACT_VERSION);
  assert.equal(descriptors[0]?.contract?.cost, "low");
  assert.deepEqual(descriptors[0]?.contract?.recommendedBeforeTools, ["stat_path", "list_directory"]);
});

test("tool selection uses contracts to avoid unrelated high-cost tools", () => {
  const input = makeBrainInput([
    {
      name: "read_text_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      capability: "fs.read",
      requiresApproval: false,
    },
    {
      name: "search_workspace",
      description: "Search local files",
      inputSchema: { type: "object" },
      capability: "fs.search",
      requiresApproval: false,
    },
    {
      name: "web_fetch",
      description: "Fetch a web page",
      inputSchema: { type: "object" },
      capability: "web.fetch",
      requiresApproval: false,
    },
    {
      name: "run_terminal_command",
      description: "Run a shell command",
      inputSchema: { type: "object" },
      capability: "process.command",
      requiresApproval: true,
    },
  ], "inspect the local src folder");

  const selection = selectToolsForPlanner(input, 2);
  const names = selection.selected.map((tool) => tool.name);
  assert.deepEqual(names, ["read_text_file", "search_workspace"]);
});

test("tool selection keeps web search available for Chinese online lookup intent", () => {
  const input = makeBrainInput([
    {
      name: "read_text_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      capability: "fs.read",
      requiresApproval: false,
    },
    {
      name: "search_workspace",
      description: "Search local files",
      inputSchema: { type: "object" },
      capability: "fs.search",
      requiresApproval: false,
    },
    {
      name: "web_search",
      description: "Search the public web",
      inputSchema: { type: "object" },
      capability: "web.search",
      requiresApproval: false,
    },
    {
      name: "web_fetch",
      description: "Fetch a web page",
      inputSchema: { type: "object" },
      capability: "web.fetch",
      requiresApproval: false,
    },
    {
      name: "run_terminal_command",
      description: "Run a shell command",
      inputSchema: { type: "object" },
      capability: "process.command",
      requiresApproval: true,
    },
  ], "联网搜一下 deepseek harness 最新信息");

  const selection = selectToolsForPlanner(input, 3);
  const names = selection.selected.map((tool) => tool.name);
  assert.ok(names.includes("web_search"));
});

function makeBrainInput(availableTools: ToolDescriptor[], userMessage: string): BrainInput {
  return {
    runId: "run_contract_test",
    priorTurns: [],
    history: [],
    availableTools,
    context: {
      stable: [],
      volatile: [{
        id: "user",
        kind: "user_turn",
        layer: "volatile",
        source: "test",
        content: userMessage,
        provenance: { source: "test", retrievedAt: new Date("2026-01-01T00:00:00Z"), method: "direct" },
        score: 1,
        budget: 10,
      }],
      live: [],
      totalBudget: 10,
      builtAt: new Date("2026-01-01T00:00:00Z"),
    },
  };
}

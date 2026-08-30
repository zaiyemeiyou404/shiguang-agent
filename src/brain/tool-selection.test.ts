import { test } from "node:test";
import * as assert from "node:assert/strict";

import { selectToolsForPlanner } from "./tool-selection.js";
import type { BrainInput } from "./types.js";
import type { ContextBundle } from "../context/types.js";
import type { ToolDescriptor } from "../tools/types.js";

function makeTool(name: string, description = name): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeContext(userTurn: string): ContextBundle {
  return {
    stable: [],
    volatile: [{
      id: "user-1",
      kind: "user_turn",
      layer: "volatile",
      source: "test",
      content: userTurn,
      provenance: { source: "test", retrievedAt: new Date("2026-01-01T00:00:00Z"), method: "direct" },
      score: 1,
      budget: userTurn.length,
    }],
    live: [],
    totalBudget: userTurn.length,
    builtAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeInput(userTurn: string, tools: ToolDescriptor[]): BrainInput {
  return {
    context: makeContext(userTurn),
    runId: "run_test",
    priorTurns: [],
    history: [],
    availableTools: tools,
  };
}

test("selectToolsForPlanner keeps web tools for Chinese web-search requests", () => {
  const tools = [
    makeTool("inspect_project"),
    makeTool("list_directory"),
    makeTool("stat_path"),
    makeTool("read_text_file"),
    makeTool("search_workspace"),
    makeTool("code_map"),
    makeTool("symbol_search"),
    makeTool("dependency_graph"),
    makeTool("write_text_file"),
    makeTool("patch_text_file"),
    makeTool("copy_path"),
    makeTool("move_path"),
    makeTool("delete_path"),
    makeTool("run_validation"),
    makeTool("run_terminal_command"),
    makeTool("git_status"),
    makeTool("git_diff"),
    makeTool("collect_diagnostics"),
    makeTool("web_search", "Search web pages"),
    makeTool("web_fetch", "Fetch a web page"),
    makeTool("github_repo"),
    makeTool("search_memory"),
    makeTool("remember_fact"),
    makeTool("forget_memory"),
  ];

  const selected = selectToolsForPlanner(makeInput("能搜一下红色书籍吗", tools), 14).selected.map((tool) => tool.name);

  assert.ok(selected.includes("web_search"));
  assert.ok(selected.includes("web_fetch"));
});


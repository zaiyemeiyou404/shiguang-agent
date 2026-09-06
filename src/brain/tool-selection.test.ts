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

function makeInput(userTurn: string, tools: ToolDescriptor[], history: BrainInput["history"] = []): BrainInput {
  return {
    context: makeContext(userTurn),
    runId: "run_test",
    priorTurns: [],
    history,
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

test("selectToolsForPlanner keeps adaptive rule tools for correction requests", () => {
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
    makeTool("web_search"),
    makeTool("web_fetch"),
    makeTool("record_agent_rule", "Append a reusable approved operating rule"),
    makeTool("list_custom_extensions", "List custom skills and tools"),
    makeTool("search_memory"),
    makeTool("remember_fact"),
    makeTool("forget_memory"),
  ];

  const selected = selectToolsForPlanner(
    makeInput("This was wrong. Reflect and learn a rule for next time.", tools),
    14,
  ).selected.map((tool) => tool.name);

  assert.ok(selected.includes("record_agent_rule"));
  assert.ok(selected.includes("list_custom_extensions"));
});

test("selectToolsForPlanner prefers follow-up evidence over repeated directory listing", () => {
  const tools = [
    makeTool("list_directory"),
    makeTool("read_text_file"),
    makeTool("code_map"),
    makeTool("web_search"),
    makeTool("web_fetch"),
  ];
  const history: BrainInput["history"] = [
    {
      action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
      ok: true,
      output: { entries: [{ name: "README.md", kind: "file" }] },
      metadata: { category: "tool_observation", summary: "listed root", retryable: false, toolName: "list_directory" },
    },
  ];

  const selected = selectToolsForPlanner(makeInput("分析这个项目", tools, history), 2).selected.map((tool) => tool.name);

  assert.ok(selected.includes("read_text_file") || selected.includes("code_map"), `selected tools: ${selected.join(", ")}`);
});

test("selectToolsForPlanner prioritizes validation after a workspace mutation", () => {
  const tools = [
    makeTool("read_text_file"),
    makeTool("patch_text_file"),
    makeTool("run_validation"),
    makeTool("web_search"),
  ];
  const history: BrainInput["history"] = [
    {
      action: { kind: "tool_call", toolName: "patch_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts" },
      metadata: {
        category: "tool_observation",
        summary: "patched file",
        retryable: false,
        toolName: "patch_text_file",
        workspaceMutation: true,
        validationMode: "all",
      },
    },
  ];

  const selected = selectToolsForPlanner(makeInput("继续", tools, history), 2).selected.map((tool) => tool.name);

  assert.ok(selected.includes("run_validation"), `selected tools: ${selected.join(", ")}`);
});

test("selectToolsForPlanner follows the active task-loop evidence criterion", () => {
  const tools = [
    makeTool("web_search", "Search web pages"),
    makeTool("web_fetch", "Fetch a web page"),
    makeTool("run_validation"),
    makeTool("read_text_file"),
    makeTool("search_workspace"),
    makeTool("list_directory"),
    makeTool("dependency_graph"),
  ];
  const input = makeInput("继续看这个文件", tools);
  input.workingMemory = {
    step: 2,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "分析本地文件",
      mode: "workspace",
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "collect_evidence",
      tasks: [{
        id: "collect_evidence",
        title: "读取目标文件",
        status: "active",
        criteria: [{ id: "target_evidence", description: "已经读取目标文件", status: "pending" }],
        toolHints: ["read_text_file", "search_workspace"],
        attempts: 0,
      }],
    },
  };

  const selected = selectToolsForPlanner(input, 3).selected.map((tool) => tool.name);

  assert.deepEqual(selected, ["read_text_file", "search_workspace", "list_directory"]);
});

test("selectToolsForPlanner avoids unrelated high-cost tools when the loop has enough evidence", () => {
  const tools = [
    makeTool("web_search", "Search web pages"),
    makeTool("mcp_remote_search", "Remote MCP search"),
    makeTool("read_text_file"),
    makeTool("collect_diagnostics"),
    makeTool("run_validation"),
  ];
  const input = makeInput("继续", tools);
  input.workingMemory = {
    step: 6,
    phase: "validate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "验证改动",
      mode: "validation",
      evidenceCount: 5,
      completionGateCount: 1,
      currentTaskId: "validate",
      tasks: [{
        id: "validate",
        title: "运行验证",
        status: "active",
        criteria: [{ id: "validation_passed", description: "验证通过", status: "pending" }],
        toolHints: ["run_validation"],
        attempts: 1,
      }],
    },
  };

  const selected = selectToolsForPlanner(input, 2).selected.map((tool) => tool.name);

  assert.ok(selected.includes("run_validation"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("web_search"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("mcp_remote_search"), `selected tools: ${selected.join(", ")}`);
});

test("selectToolsForPlanner downranks repeated weak web fetch evidence", () => {
  const tools = [
    makeTool("web_fetch", "Fetch a web page"),
    makeTool("web_search", "Search web pages"),
    makeTool("read_text_file"),
  ];
  const input = makeInput("看一下 https://example.test/article 的正文", tools);
  input.workingMemory = {
    step: 3,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "看一下 https://example.test/article 的正文",
      mode: "web",
      evidenceCount: 2,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      evidenceLog: [
        {
          step: 1,
          toolName: "web_fetch",
          kind: "web",
          quality: "weak",
          target: "https://example.test/article",
          summary: "Only navigation text was extracted.",
        },
        {
          step: 2,
          toolName: "web_fetch",
          kind: "web",
          quality: "weak",
          target: "https://example.test/article",
          summary: "Still no readable body.",
        },
      ],
      tasks: [{
        id: "analyze_evidence",
        title: "Extract body",
        status: "active",
        criteria: [{ id: "body_evidence", description: "body", status: "pending" }],
        attempts: 2,
      }],
    },
  };

  const selected = selectToolsForPlanner(input, 1).selected.map((tool) => tool.name);

  assert.deepEqual(selected, ["web_search"]);
});

test("selectToolsForPlanner pivots from weak directory discovery to key file evidence", () => {
  const tools = [
    makeTool("list_directory"),
    makeTool("read_text_file"),
    makeTool("code_map"),
    makeTool("web_search"),
  ];
  const input = makeInput("整体分析这个项目", tools);
  input.workingMemory = {
    step: 3,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "整体分析这个项目",
      mode: "workspace",
      evidenceCount: 2,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      evidenceLog: [
        {
          step: 1,
          toolName: "list_directory",
          kind: "workspace",
          quality: "weak",
          target: ".",
          summary: "Listed root without key file content.",
        },
        {
          step: 2,
          toolName: "list_directory",
          kind: "workspace",
          quality: "weak",
          target: ".",
          summary: "Listed root again.",
        },
      ],
      tasks: [{
        id: "analyze_evidence",
        title: "Read key files",
        status: "active",
        criteria: [{ id: "key_file_evidence", description: "key file", status: "pending" }],
        attempts: 1,
      }],
    },
  };

  const selected = selectToolsForPlanner(input, 2).selected.map((tool) => tool.name);

  assert.ok(selected.includes("read_text_file") || selected.includes("code_map"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("list_directory"), `selected tools: ${selected.join(", ")}`);
});

test("selectToolsForPlanner keeps explicit URL intent ahead of stale workspace evidence", () => {
  const tools = [
    makeTool("inspect_project"),
    makeTool("list_directory"),
    makeTool("read_text_file"),
    makeTool("search_workspace"),
    makeTool("web_search", "Search web pages"),
    makeTool("web_fetch", "Fetch a web page"),
  ];
  const history: BrainInput["history"] = [{
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    ok: true,
    output: { entries: [{ name: "pubspec.yaml", kind: "file" }] },
    metadata: {
      category: "tool_observation",
      summary: "listed workspace files",
      retryable: false,
      toolName: "list_directory",
    },
  }];

  const selected = selectToolsForPlanner(
    makeInput("看一下 https://example.test/article 的正文", tools, history),
    3,
  ).selected.map((tool) => tool.name);

  assert.ok(selected.includes("web_fetch"), `selected tools: ${selected.join(", ")}`);
  assert.ok(selected.includes("web_search"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("read_text_file"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("list_directory"), `selected tools: ${selected.join(", ")}`);
});

test("selectToolsForPlanner exposes link extraction after weak fetched HTML", () => {
  const tools = [
    makeTool("read_text_file"),
    makeTool("web_search", "Search web pages"),
    makeTool("web_fetch", "Fetch a web page"),
    makeTool("web_extract_links", "Extract links from HTML"),
  ];
  const history: BrainInput["history"] = [{
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/home" } },
    ok: true,
    output: {
      url: "https://example.test/home",
      text: "下载客户端",
      htmlPreview: "<html><body><a href='/article.html'>阅读全文</a></body></html>".repeat(3),
    },
    metadata: {
      category: "tool_observation",
      summary: "fetched shell page",
      retryable: false,
      toolName: "web_fetch",
    },
  }];

  const selected = selectToolsForPlanner(
    makeInput("继续看这个网页正文", tools, history),
    2,
  ).selected.map((tool) => tool.name);

  assert.ok(selected.includes("web_extract_links"), `selected tools: ${selected.join(", ")}`);
  assert.ok(!selected.includes("read_text_file"), `selected tools: ${selected.join(", ")}`);
});

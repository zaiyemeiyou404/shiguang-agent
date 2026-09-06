import { test } from "node:test";
import * as assert from "node:assert/strict";

import { judgeTaskCompletion, judgeToolCallValue } from "./completion.js";
import type { ActionResult, BrainDecision, BrainInput, WorkingMemorySnapshot } from "./types.js";
import type { ContextBundle, ContextItem } from "../context/types.js";
import type { ToolDescriptor } from "../tools/types.js";

function makeContext(message: string): ContextBundle {
  const userTurn: ContextItem = {
    id: "user-turn",
    kind: "user_turn",
    layer: "volatile",
    source: "session",
    content: message,
    provenance: {
      source: "session",
      retrievedAt: new Date("2026-01-01T00:00:00.000Z"),
      method: "direct",
    },
    score: 1,
    budget: 1,
  };

  return {
    stable: [],
    volatile: [userTurn],
    live: [],
    totalBudget: 1,
    builtAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeInput(message: string, availableTools: ToolDescriptor[]): BrainInput {
  return {
    context: makeContext(message),
    runId: "run_completion",
    priorTurns: [],
    history: [],
    availableTools,
  };
}

test("judgeTaskCompletion requires validation after a workspace mutation", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "hello.py" } },
    ok: true,
    output: { path: "hello.py" },
    metadata: {
      category: "tool_observation",
      summary: "wrote hello.py",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("write hello.py", [{ name: "run_validation", description: "validate", inputSchema: { type: "object" } }]),
    result,
    "write hello.py",
  );

  assert.equal(judgment.status, "needs_verification");
  assert.equal(judgment.recommendedToolName, "run_validation");
  assert.deepEqual(judgment.recommendedToolInput, { mode: "all" });
});

test("judgeTaskCompletion fetches a search result before final URL feedback", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "example article" } },
    ok: true,
    output: {
      query: "example article",
      results: [{ title: "Article", url: "https://example.test/article" }],
    },
    metadata: {
      category: "tool_observation",
      summary: "searched web",
      retryable: false,
      toolName: "web_search",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("看这个文章链接", [{ name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }]),
    result,
    "看这个文章链接",
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/article" });
});

test("judgeTaskCompletion treats read_text_file as answer-ready evidence", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
    ok: true,
    output: { path: "README.md", content: "# Project" },
    metadata: {
      category: "tool_observation",
      summary: "read README",
      retryable: false,
      toolName: "read_text_file",
    },
  };

  const judgment = judgeTaskCompletion(makeInput("分析 README.md", []), result, "分析 README.md");

  assert.equal(judgment.status, "ready");
});

test("judgeTaskCompletion uses task-loop criteria to fetch explicit URLs before answering", () => {
  const input = makeInput("看一下 https://example.test/article 的正文", [
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } },
  ]);
  input.workingMemory = {
    step: 0,
    phase: "investigate",
    lastActionKind: null,
    taskLoop: {
      objective: "看一下 https://example.test/article 的正文",
      mode: "web",
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "collect_evidence",
      tasks: [
        {
          id: "collect_evidence",
          title: "Locate source",
          status: "active",
          criteria: [{ id: "source_located", description: "source", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, null, "看一下 https://example.test/article 的正文");

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/article" });
});

test("judgeTaskCompletion uses task-loop answer step as a completion gate", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/article" } },
    ok: true,
    output: { url: "https://example.test/article", text: "article body ".repeat(20) },
    metadata: {
      category: "tool_observation",
      summary: "fetched body",
      retryable: false,
      toolName: "web_fetch",
    },
  };
  const input = makeInput("总结这个网页", []);
  input.workingMemory = {
    step: 1,
    phase: "summarize",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "总结这个网页",
      mode: "web",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "answer",
      tasks: [
        {
          id: "answer",
          title: "Answer",
          status: "active",
          criteria: [{ id: "final_feedback", description: "answer", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, result, "总结这个网页");

  assert.equal(judgment.status, "ready");
  assert.match(judgment.reason, /answer step/);
});

test("judgeTaskCompletion follows self-check evidence gaps before final feedback", () => {
  const input = makeInput("summarize the article", [
    { name: "web_fetch", description: "Fetch a web page", inputSchema: { type: "object" } },
  ]);
  input.history = [{
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "article" } },
    ok: true,
    output: { results: [{ title: "Article", url: "https://example.test/article" }] },
    metadata: { category: "tool_observation", summary: "searched article", retryable: false, toolName: "web_search" },
  }];
  input.workingMemory = {
    step: 1,
    phase: "summarize",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "summarize the article",
      mode: "web",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "answer",
      selfCheck: {
        status: "needs_evidence",
        summary: "Task still needs readable article body.",
        checkedAtStep: 1,
        missingCriteria: ["body_evidence"],
        latestEvidenceQuality: "strong",
      },
      tasks: [{
        id: "answer",
        title: "answer",
        status: "active",
        criteria: [{ id: "final_feedback", description: "final feedback", status: "pending" }],
        attempts: 0,
      }],
    },
  };

  const judgment = judgeTaskCompletion(input, input.history[0] ?? null, "summarize the article");

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/article" });
});

test("judgeTaskCompletion accepts strong evidence from the task-loop ledger", () => {
  const latestResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "article mirror" } },
    ok: true,
    output: { results: [{ title: "mirror", url: "https://example.test/mirror" }] },
    metadata: {
      category: "tool_observation",
      summary: "searched mirror candidates",
      retryable: false,
      toolName: "web_search",
    },
  };
  const input = makeInput("总结这个网页", []);
  input.workingMemory = {
    step: 3,
    phase: "summarize",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "总结这个网页",
      mode: "web",
      evidenceCount: 2,
      completionGateCount: 0,
      currentTaskId: "answer",
      evidenceLog: [{
        step: 2,
        toolName: "web_fetch",
        kind: "web",
        quality: "strong",
        target: "https://example.test/article",
        summary: "fetched readable article body",
      }],
      tasks: [
        {
          id: "answer",
          title: "Answer",
          status: "active",
          criteria: [{ id: "final_feedback", description: "answer", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, latestResult, "总结这个网页");

  assert.equal(judgment.status, "ready");
  assert.match(judgment.reason, /answer step/);
});

test("judgeTaskCompletion requires key file evidence before workspace answer-step feedback", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "code_map", toolInput: { maxFiles: 1200 } },
    ok: true,
    output: { entrypoints: [{ path: "lib/main.dart" }], fileStats: { filesScanned: 80 } },
    metadata: {
      category: "tool_observation",
      summary: "mapped code",
      retryable: false,
      toolName: "code_map",
    },
  };
  const input = makeInput("分析这个项目", [
    { name: "read_text_file", description: "read", inputSchema: { type: "object" } },
    { name: "code_map", description: "map", inputSchema: { type: "object" } },
  ]);
  input.history = [result];
  input.workingMemory = {
    step: 2,
    phase: "summarize",
    lastActionKind: "tool_call",
    lastToolName: "code_map",
    taskLoop: {
      objective: "分析这个项目",
      mode: "workspace",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "answer",
      tasks: [
        {
          id: "answer",
          title: "Answer",
          status: "active",
          criteria: [{ id: "final_feedback", description: "answer", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, result, "分析这个项目");

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "read_text_file");
  assert.deepEqual(judgment.recommendedToolInput, { path: "lib/main.dart" });
});

test("judgeTaskCompletion uses task-loop validation criteria after mutations", () => {
  const mutation: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "hello.py" } },
    ok: true,
    output: { path: "hello.py" },
    metadata: {
      category: "tool_observation",
      summary: "wrote hello.py",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };
  const input = makeInput("写 hello.py", [{ name: "run_validation", description: "validate", inputSchema: { type: "object" } }]);
  input.history = [mutation];
  input.workingMemory = {
    step: 1,
    phase: "validate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "写 hello.py",
      mode: "edit",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "verify",
      tasks: [
        {
          id: "verify",
          title: "Validate",
          status: "active",
          criteria: [{ id: "validation_passed", description: "validate", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, mutation, "写 hello.py");

  assert.equal(judgment.status, "needs_verification");
  assert.equal(judgment.recommendedToolName, "run_validation");
  assert.deepEqual(judgment.recommendedToolInput, { mode: "all" });
});

test("judgeTaskCompletion changes recovery path after a failed target read", () => {
  const failedRead: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/missing.ts" } },
    ok: false,
    output: null,
    error: "ENOENT",
    metadata: {
      category: "tool_error",
      summary: "missing file",
      retryable: false,
      toolName: "read_text_file",
    },
  };
  const input = makeInput("修改 src/missing.ts", [
    { name: "read_text_file", description: "read", inputSchema: { type: "object" } },
    { name: "search_workspace", description: "search", inputSchema: { type: "object" } },
    { name: "list_directory", description: "list", inputSchema: { type: "object" } },
  ]);
  input.history = [failedRead];
  input.workingMemory = {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "修改 src/missing.ts",
      mode: "edit",
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "collect_evidence",
      tasks: [
        {
          id: "collect_evidence",
          title: "Inspect target",
          status: "blocked",
          criteria: [{ id: "target_evidence", description: "target", status: "failed", evidence: "ENOENT" }],
          attempts: 1,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, failedRead, "修改 src/missing.ts");

  assert.equal(judgment.status, "needs_recovery");
  assert.equal(judgment.recommendedToolName, "search_workspace");
  assert.deepEqual(judgment.recommendedToolInput, { query: "src/missing.ts" });
});

test("judgeTaskCompletion searches for a target basename after a generic failed file read", () => {
  const failedRead: ActionResult = {
    action: {
      kind: "tool_call",
      toolName: "read_text_file",
      toolInput: { path: "worktest/worktest/traintime_pda-main/pubspec.yaml" },
    },
    ok: false,
    output: null,
    error: "ENOENT",
    metadata: {
      category: "tool_error",
      summary: "missing file",
      retryable: false,
      toolName: "read_text_file",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("分析 pubspec.yaml", [
      { name: "search_workspace", description: "search", inputSchema: { type: "object" } },
      { name: "list_directory", description: "list", inputSchema: { type: "object" } },
    ]),
    failedRead,
    "分析 pubspec.yaml",
  );

  assert.equal(judgment.status, "needs_recovery");
  assert.equal(judgment.recommendedToolName, "search_workspace");
  assert.deepEqual(judgment.recommendedToolInput, { query: "pubspec.yaml" });
});

test("judgeTaskCompletion recovers failed web fetch with search", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/article" } },
    ok: false,
    output: null,
    error: "fetch failed",
    metadata: {
      category: "tool_error",
      summary: "fetch failed",
      retryable: false,
      toolName: "web_fetch",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("看一下 https://example.test/article 的正文", [{ name: "web_search", description: "search", inputSchema: { type: "object" } }]),
    result,
    "看一下 https://example.test/article 的正文",
  );

  assert.equal(judgment.status, "needs_recovery");
  assert.equal(judgment.recommendedToolName, "web_search");
});

test("judgeTaskCompletion recovers failed web fetch with the next search candidate", () => {
  const search: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "article" } },
    ok: true,
    output: {
      results: [
        { title: "Blocked", url: "https://example.test/blocked" },
        { title: "Mirror", url: "https://mirror.example.test/article" },
      ],
    },
    metadata: { category: "tool_observation", summary: "searched candidates", retryable: false, toolName: "web_search" },
  };
  const failedFetch: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/blocked" } },
    ok: false,
    output: null,
    error: "timeout",
    metadata: { category: "tool_error", summary: "fetch failed", retryable: false, toolName: "web_fetch", errorKind: "timeout" },
  };
  const input = makeInput("summarize the article", [
    { name: "web_fetch", description: "Fetch web page", inputSchema: { type: "object" } },
    { name: "web_search", description: "Search web", inputSchema: { type: "object" } },
  ]);
  input.history = [search, failedFetch];

  const judgment = judgeTaskCompletion(input, failedFetch, "summarize the article");

  assert.equal(judgment.status, "needs_recovery");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://mirror.example.test/article" });
});

test("judgeTaskCompletion treats html preview alone as weak web evidence", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/article" } },
    ok: true,
    output: {
      url: "https://example.test/article",
      title: "Article",
      text: "",
      htmlPreview: "<html><body><nav>APP 下载 客户端 评论 举报 分享</nav></body></html>".repeat(10),
      articleCandidates: [],
    },
    metadata: {
      category: "tool_observation",
      summary: "fetched html preview only",
      retryable: false,
      toolName: "web_fetch",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("看一下 https://example.test/article 的正文", [{ name: "web_search", description: "search", inputSchema: { type: "object" } }]),
    result,
    "看一下 https://example.test/article 的正文",
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_search");
});

test("judgeTaskCompletion fetches the next search candidate after weak body evidence", () => {
  const search: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "red books" } },
    ok: true,
    output: {
      results: [
        { title: "Weak page", url: "https://example.test/weak" },
        { title: "Mirror page", url: "https://example.test/mirror" },
      ],
    },
    metadata: {
      category: "tool_observation",
      summary: "searched web",
      retryable: false,
      toolName: "web_search",
    },
  };
  const weakFetch: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/weak" } },
    ok: true,
    output: { url: "https://example.test/weak", text: "APP 下载 评论 分享" },
    metadata: {
      category: "tool_observation",
      summary: "fetched weak body",
      retryable: false,
      toolName: "web_fetch",
    },
  };
  const input = makeInput("搜索红色书籍并抓正文", [
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } },
    { name: "web_search", description: "search", inputSchema: { type: "object" } },
  ]);
  input.history = [search, weakFetch];
  input.workingMemory = {
    step: 2,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "搜索红色书籍并抓正文",
      mode: "web",
      evidenceCount: 2,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      tasks: [
        {
          id: "analyze_evidence",
          title: "Extract body",
          status: "active",
          criteria: [{ id: "body_evidence", description: "body", status: "pending" }],
          attempts: 1,
        },
      ],
    },
  };

  const judgment = judgeTaskCompletion(input, weakFetch, "搜索红色书籍并抓正文");

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/mirror" });
});

test("judgeTaskCompletion asks for code_map after broad project discovery", () => {
  const result: ActionResult = {
    action: { kind: "tool_call", toolName: "inspect_project", toolInput: {} },
    ok: true,
    output: { files: 120 },
    metadata: {
      category: "tool_observation",
      summary: "inspected project",
      retryable: false,
      toolName: "inspect_project",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput("整体分析一下这个项目", [{ name: "code_map", description: "map code", inputSchema: { type: "object" } }]),
    result,
    "整体分析一下这个项目",
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "code_map");
});

test("judgeToolCallValue redirects web requests away from local workspace tools", () => {
  const message = "please read https://example.test/article and summarize it";
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
  };

  const judgment = judgeToolCallValue(
    makeInput(message, [
      { name: "web_fetch", description: "fetch a page", inputSchema: { type: "object" } },
      { name: "read_text_file", description: "read a file", inputSchema: { type: "object" } },
    ]),
    decision,
    null,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/article" });
});

test("judgeToolCallValue avoids remote lookup for workspace-only analysis", () => {
  const message = "analyze this project structure";
  const memory: WorkingMemorySnapshot = {
    step: 2,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "inspect_project",
    taskLoop: {
      objective: message,
      mode: "workspace",
      evidenceCount: 1,
      completionGateCount: 0,
    },
  };
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "project structure" } },
  };

  const judgment = judgeToolCallValue(
    { ...makeInput(message, [{ name: "web_search", description: "search web", inputSchema: { type: "object" } }]), workingMemory: memory },
    decision,
    null,
    message,
  );

  assert.equal(judgment.status, "avoid");
});

test("judgeToolCallValue requires read evidence before workspace mutations", () => {
  const message = "fix src/app.ts";
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "src/app.ts", content: "fixed" } },
  };

  const judgment = judgeToolCallValue(
    makeInput(message, [
      { name: "read_text_file", description: "read a file", inputSchema: { type: "object" } },
      { name: "write_text_file", description: "write a file", inputSchema: { type: "object" } },
    ]),
    decision,
    null,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "read_text_file");
  assert.deepEqual(judgment.recommendedToolInput, { path: "src/app.ts" });
});

test("judgeToolCallValue redirects tools that do not satisfy the active task-loop criterion", () => {
  const message = "搜索红色书籍并抓正文";
  const searchResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "红色书籍" } },
    ok: true,
    output: { results: [{ title: "红色书籍", url: "https://example.test/red-books" }] },
    metadata: {
      category: "tool_observation",
      summary: "found result",
      retryable: false,
      toolName: "web_search",
    },
  };
  const input = makeInput(message, [
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } },
    { name: "read_text_file", description: "read", inputSchema: { type: "object" } },
  ]);
  input.history = [searchResult];
  input.workingMemory = {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: message,
      mode: "web",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      tasks: [
        {
          id: "analyze_evidence",
          title: "Extract body",
          status: "active",
          criteria: [{ id: "body_evidence", description: "body", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeToolCallValue(
    input,
    { action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } } },
    searchResult,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/red-books" });
});

test("judgeToolCallValue enforces web task-loop mode before terminal or project tools", () => {
  const message = "read this article https://example.test/red-books";
  const input = makeInput(message, [
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } },
    { name: "web_search", description: "search", inputSchema: { type: "object" } },
    { name: "run_terminal_command", description: "terminal", inputSchema: { type: "object" } },
  ]);
  input.workingMemory = {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: message,
      mode: "web",
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "collect_evidence",
      tasks: [
        {
          id: "collect_evidence",
          title: "Locate web source",
          status: "active",
          criteria: [{ id: "source_located", description: "source", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeToolCallValue(
    input,
    { action: { kind: "tool_call", toolName: "run_terminal_command", toolInput: { command: "dir" } } },
    null,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/red-books" });
});

test("judgeToolCallValue redirects to validation when validation criteria is active", () => {
  const message = "写 hello.py";
  const mutation: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "hello.py" } },
    ok: true,
    output: { path: "hello.py" },
    metadata: {
      category: "tool_observation",
      summary: "wrote hello.py",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };
  const input = makeInput(message, [
    { name: "run_validation", description: "validate", inputSchema: { type: "object" } },
    { name: "read_text_file", description: "read", inputSchema: { type: "object" } },
  ]);
  input.history = [mutation];
  input.workingMemory = {
    step: 1,
    phase: "validate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: message,
      mode: "edit",
      evidenceCount: 1,
      completionGateCount: 0,
      currentTaskId: "verify",
      tasks: [
        {
          id: "verify",
          title: "Validate",
          status: "active",
          criteria: [{ id: "validation_passed", description: "validate", status: "pending" }],
          attempts: 0,
        },
      ],
    },
  };

  const judgment = judgeToolCallValue(
    input,
    { action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "hello.py" } } },
    mutation,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "run_validation");
  assert.deepEqual(judgment.recommendedToolInput, { mode: "all" });
});

test("judgeTaskCompletion requires fetching search results for broad web search requests", () => {
  const message = "能搜一下红色书籍吗";
  const searchResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "红色书籍" } },
    ok: true,
    output: { results: [{ title: "红色书籍推荐", url: "https://example.test/red-books" }] },
    metadata: {
      category: "tool_observation",
      summary: "found candidate pages",
      retryable: false,
      toolName: "web_search",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput(message, [{ name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }]),
    searchResult,
    message,
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/red-books" });
});

test("judgeToolCallValue uses the next search candidate before local tools on web tasks", () => {
  const message = "继续看这个网页正文";
  const searchResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "红色文化" } },
    ok: true,
    output: { results: [{ title: "红色文化", url: "https://example.test/red-culture" }] },
    metadata: {
      category: "tool_observation",
      summary: "found candidate pages",
      retryable: false,
      toolName: "web_search",
    },
  };
  const input = makeInput(message, [
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object" } },
    { name: "read_text_file", description: "read", inputSchema: { type: "object" } },
  ]);
  input.history = [searchResult];
  input.workingMemory = {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    taskLoop: {
      objective: "搜索红色文化网页正文",
      mode: "web",
      evidenceCount: 1,
      completionGateCount: 0,
    },
  };

  const judgment = judgeToolCallValue(
    input,
    { action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "pubspec.yaml" } } },
    searchResult,
    message,
  );

  assert.equal(judgment.status, "redirect");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/red-culture" });
});

test("judgeTaskCompletion extracts links from weak fetched HTML before searching again", () => {
  const message = "看一下 https://example.test/home 的正文";
  const fetchResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/home" } },
    ok: true,
    output: {
      url: "https://example.test/home",
      text: "下载客户端\n关注公众号\n扫码查看",
      htmlPreview: "<html><body><a href='/article.html'>阅读全文</a><nav>下载客户端</nav></body></html>".repeat(2),
    },
    metadata: {
      category: "tool_observation",
      summary: "fetched weak shell page",
      retryable: false,
      toolName: "web_fetch",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput(message, [
      { name: "web_extract_links", description: "extract links", inputSchema: { type: "object" } },
      { name: "web_search", description: "search", inputSchema: { type: "object" } },
    ]),
    fetchResult,
    message,
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_extract_links");
});

test("judgeTaskCompletion fetches the best extracted article link", () => {
  const message = "继续看网页正文";
  const linkResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_extract_links", toolInput: { baseUrl: "https://example.test/home" } },
    ok: true,
    output: {
      links: [
        { url: "https://example.test/article.html", text: "阅读全文", score: 50, sameHost: true },
      ],
    },
    metadata: {
      category: "tool_observation",
      summary: "extracted links",
      retryable: false,
      toolName: "web_extract_links",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput(message, [{ name: "web_fetch", description: "fetch", inputSchema: { type: "object" } }]),
    linkResult,
    message,
  );

  assert.equal(judgment.status, "needs_more_evidence");
  assert.equal(judgment.recommendedToolName, "web_fetch");
  assert.deepEqual(judgment.recommendedToolInput, { url: "https://example.test/article.html" });
});

test("judgeTaskCompletion recovers failed file reads with find_files when available", () => {
  const message = "分析 pubspec.yaml";
  const failedRead: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "worktest/worktest/pubspec.yaml" } },
    ok: false,
    output: null,
    error: "ENOENT",
    metadata: {
      category: "tool_error",
      summary: "missing file",
      retryable: false,
      toolName: "read_text_file",
    },
  };

  const judgment = judgeTaskCompletion(
    makeInput(message, [
      { name: "find_files", description: "find files", inputSchema: { type: "object" } },
      { name: "search_workspace", description: "search", inputSchema: { type: "object" } },
    ]),
    failedRead,
    message,
  );

  assert.equal(judgment.status, "needs_recovery");
  assert.equal(judgment.recommendedToolName, "find_files");
  assert.deepEqual(judgment.recommendedToolInput, { query: "pubspec.yaml", maxResults: 20 });
});

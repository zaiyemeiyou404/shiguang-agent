import { test } from "node:test";
import * as assert from "node:assert/strict";

import { applyActionResultToWorkingMemory, runLoop } from "./loop.js";
import { RulePlanner } from "./planner.js";
import type { BrainDecision, BrainInput, ActionResult } from "./types.js";
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

test("runLoop pauses with step_limit when the step budget is exhausted", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    reasoning: "Keep inspecting a large workspace.",
  };

  const state = await runLoop(
    {
      context: makeContext("inspect this large project"),
      runId: "run_step_limit",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decision;
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          return {
            action: next.action,
            ok: true,
            output: { entries: [] },
            metadata: {
              category: "tool_observation",
              summary: "Listed directory.",
              retryable: false,
              toolName: "list_directory",
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    2,
  );

  assert.equal(state.steps, 2);
  assert.equal(state.stopReason, "step_limit");
  assert.match(state.stopSummary ?? "", /2 步安全预算/);
  assert.match(state.stopSummary ?? "", /最近工具：list_directory/);
  assert.equal(state.history.length, 2);
});

test("runLoop starts a fresh task-loop for a standalone new task", async () => {
  const staleResult: ActionResult = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://old.example.test" } },
    ok: true,
    output: { url: "https://old.example.test", text: "old page body".repeat(30) },
    metadata: { category: "tool_observation", summary: "old web fetch", retryable: false, toolName: "web_fetch" },
  };
  const plannerHistoryLengths: number[] = [];

  const state = await runLoop(
    {
      context: makeContext("分析 README.md"),
      runId: "run_fresh_task_loop",
      priorTurns: [],
      history: [staleResult],
      workingMemory: {
        step: 9,
        phase: "summarize",
        lastActionKind: "tool_call",
        taskLoop: {
          objective: "看 https://old.example.test",
          mode: "web",
          evidenceCount: 3,
          completionGateCount: 0,
          currentTaskId: "answer",
          needsFinalAnswer: true,
        },
      },
      availableTools: [{ name: "inspect_project", description: "Inspect project", inputSchema: { type: "object" } }],
    },
    {
      planner: {
        async decide(input): Promise<BrainDecision> {
          plannerHistoryLengths.push(input.history.length);
          return {
            action: { kind: "tool_call", toolName: "inspect_project", toolInput: {} },
            reasoning: "Inspect the new workspace task.",
          };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          return {
            action: next.action,
            ok: true,
            output: { topLevelEntries: [{ name: "README.md", kind: "file" }] },
            metadata: { category: "tool_observation", summary: "inspected new task", retryable: false, toolName: "inspect_project" },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    1,
  );

  assert.equal(plannerHistoryLengths[0], 0);
  assert.equal(state.steps, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.workingMemory.taskLoop?.objective, "分析 README.md");
  assert.equal(state.workingMemory.taskLoop?.mode, "workspace");
});

test("applyActionResultToWorkingMemory records a compact task-loop evidence ledger", () => {
  const previous = {
    step: 0,
    phase: "investigate" as const,
    lastActionKind: null,
    taskLoop: {
      objective: "read README.md",
      mode: "workspace" as const,
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      tasks: [{
        id: "analyze_evidence",
        title: "Read key file",
        status: "active" as const,
        criteria: [{ id: "key_file_evidence", description: "key file", status: "pending" as const }],
        attempts: 0,
      }],
    },
  };

  const next = applyActionResultToWorkingMemory(previous, 1, {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
    ok: true,
    output: { path: "README.md", content: "# Project\n" },
    metadata: {
      category: "tool_observation",
      summary: "read README.md",
      retryable: false,
      toolName: "read_text_file",
    },
  });

  assert.deepEqual(next.taskLoop?.evidenceLog, [{
    step: 1,
    toolName: "read_text_file",
    kind: "file",
    quality: "strong",
    target: "README.md",
    summary: "read README.md",
  }]);
  assert.equal(next.taskLoop?.lastEvidenceTool, "read_text_file");
});

test("applyActionResultToWorkingMemory marks final readiness only after self-check passes", () => {
  const previous = {
    step: 0,
    phase: "investigate" as const,
    lastActionKind: null,
    taskLoop: {
      objective: "read README.md",
      mode: "workspace" as const,
      evidenceCount: 0,
      completionGateCount: 0,
      currentTaskId: "analyze_evidence",
      tasks: [{
        id: "analyze_evidence",
        title: "Read key file",
        status: "active" as const,
        criteria: [{ id: "key_file_evidence", description: "key file", status: "pending" as const }],
        attempts: 0,
      }],
    },
  };

  const next = applyActionResultToWorkingMemory(previous, 1, {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
    ok: true,
    output: { path: "README.md", content: "# Project\n" },
    metadata: {
      category: "tool_observation",
      summary: "read README.md",
      retryable: false,
      toolName: "read_text_file",
    },
  });

  assert.equal(next.taskLoop?.selfCheck?.status, "passed");
  assert.equal(next.taskLoop?.needsFinalAnswer, true);
});

test("runLoop keeps the previous checkpoint for continuation messages", async () => {
  const previousResult: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
    ok: true,
    output: { path: "README.md", content: "# Project" },
    metadata: { category: "tool_observation", summary: "read README", retryable: false, toolName: "read_text_file" },
  };
  const plannerHistoryLengths: number[] = [];

  const state = await runLoop(
    {
      context: makeContext("继续上次暂停的任务。"),
      runId: "run_resume_task_loop",
      priorTurns: [],
      history: [previousResult],
      workingMemory: {
        step: 1,
        phase: "investigate",
        lastActionKind: "tool_call",
        taskLoop: {
          objective: "分析 README.md",
          mode: "workspace",
          evidenceCount: 1,
          completionGateCount: 0,
          currentTaskId: "analyze_evidence",
          needsFinalAnswer: false,
        },
      },
      availableTools: [],
    },
    {
      planner: {
        async decide(input): Promise<BrainDecision> {
          plannerHistoryLengths.push(input.history.length);
          return { action: { kind: "respond", content: "继续完成。" }, reasoning: "Resume previous checkpoint." };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          return {
            action: next.action,
            ok: true,
            output: next.action.content,
            metadata: { category: "assistant_response", summary: "resumed", retryable: false },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "stop", reason: "respond" } as const;
        },
      },
    },
    2,
  );

  assert.equal(plannerHistoryLengths[0], 1);
  assert.equal(state.steps, 2);
  assert.equal(state.history.length, 2);
  assert.equal(state.workingMemory.taskLoop?.objective, "分析 README.md");
});

test("runLoop gates premature final feedback until active task-loop evidence is collected", async () => {
  const dispatchedTools: string[] = [];

  const state = await runLoop(
    {
      context: makeContext("修改 src/app.ts"),
      runId: "run_task_loop_premature_response_gate",
      priorTurns: [],
      history: [],
      workingMemory: {
        step: 0,
        phase: "investigate",
        lastActionKind: null,
        taskLoop: {
          objective: "修改 src/app.ts",
          mode: "edit",
          evidenceCount: 0,
          completionGateCount: 0,
          currentTaskId: "collect_evidence",
          tasks: [{
            id: "collect_evidence",
            title: "检查目标文件",
            status: "active",
            criteria: [{ id: "target_evidence", description: "已读取目标文件", status: "pending" }],
            attempts: 0,
          }],
        },
      },
      availableTools: [{ name: "read_text_file", description: "Read a file", inputSchema: { type: "object" } }],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return { action: { kind: "respond", content: "已经完成。" }, reasoning: "Model tried to answer too early." };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          assert.equal(next.action.kind, "tool_call");
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          dispatchedTools.push(next.action.toolName ?? "");
          return {
            action: next.action,
            ok: true,
            output: { path: "src/app.ts", content: "export const app = true;\n" },
            metadata: { category: "tool_observation", summary: "read src/app.ts", retryable: false, toolName: next.action.toolName },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    1,
  );

  assert.deepEqual(dispatchedTools, ["read_text_file"]);
  assert.equal(state.history[0]?.action.toolName, "read_text_file");
  assert.equal(state.workingMemory.taskLoop?.tasks?.[0]?.criteria[0]?.status, "satisfied");
});

test("runLoop returns final feedback instead of spending tools after task-loop answer is ready", async () => {
  let dispatcherCalls = 0;
  const seededRead: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
    ok: true,
    output: { path: "README.md", content: "# Project\nReady evidence." },
    metadata: { category: "tool_observation", summary: "read README.md", retryable: false, toolName: "read_text_file" },
  };

  const state = await runLoop(
    {
      context: makeContext("继续上次暂停的任务。"),
      runId: "run_task_loop_ready_tool_gate",
      priorTurns: [],
      history: [seededRead],
      workingMemory: {
        step: 1,
        phase: "summarize",
        lastActionKind: "tool_call",
        taskLoop: {
          objective: "分析 README.md",
          mode: "workspace",
          evidenceCount: 1,
          completionGateCount: 0,
          currentTaskId: "answer",
          needsFinalAnswer: true,
          tasks: [{
            id: "answer",
            title: "最终反馈",
            status: "active",
            criteria: [{ id: "final_feedback", description: "输出最终反馈", status: "pending" }],
            attempts: 0,
          }],
        },
      },
      availableTools: [{ name: "list_directory", description: "List directory", inputSchema: { type: "object" }, risk: "read" }],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return {
            action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
            reasoning: "Model tried to keep using tools.",
          };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          assert.equal(next.action.kind, "respond");
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          dispatcherCalls += 1;
          return {
            action: next.action,
            ok: true,
            output: next.action.content,
            metadata: { category: "assistant_response", summary: "final feedback", retryable: false },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "stop", reason: "respond" } as const;
        },
      },
    },
    2,
  );

  assert.equal(dispatcherCalls, 1);
  assert.equal(state.history[1]?.action.kind, "respond");
  assert.match(String(state.history[1]?.output), /README.md/);
});

test("runLoop pauses on model usage budget before dispatching another tool", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    reasoning: "Inspect workspace.",
    usage: {
      provider: "test",
      model: "metered",
      requestCount: 1,
      inputTokens: 900,
      outputTokens: 50,
      totalTokens: 950,
      promptEstimateTokens: 900,
    },
  };
  const usageEvents: number[] = [];

  const state = await runLoop(
    {
      context: makeContext("inspect this large project"),
      runId: "run_usage_limit",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decision;
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(): Promise<ActionResult> {
          throw new Error("dispatcher should not run after usage budget is exhausted");
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    10,
    {
      usageBudget: { maxModelRequests: 1 },
      onUsage: async (_usage, total) => {
        usageEvents.push(total.requestCount);
      },
    },
  );

  assert.equal(state.stopReason, "usage_limit");
  assert.equal(state.history.length, 0);
  assert.equal(state.usage.requestCount, 1);
  assert.deepEqual(usageEvents, [1]);
});

test("runLoop redirects repeated read-only discovery tools to key file reads", async () => {
  const repeatedList: BrainDecision = {
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    reasoning: "Model keeps listing the same project root.",
  };
  const dispatchedTools: string[] = [];
  const availableTools: ToolDescriptor[] = [
    {
      name: "list_directory",
      description: "List a directory",
      inputSchema: { type: "object" },
      risk: "read",
    },
    {
      name: "read_text_file",
      description: "Read a file",
      inputSchema: { type: "object" },
      risk: "read",
    },
  ];

  const state = await runLoop(
    {
      context: makeContext("看一下这个 Flutter 项目"),
      runId: "run_readonly_recovery",
      priorTurns: [],
      history: [],
      availableTools,
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return repeatedList;
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          const toolName = next.action.toolName ?? "";
          dispatchedTools.push(toolName);
          if (toolName === "list_directory") {
            return {
              action: next.action,
              ok: true,
              output: {
                entries: [
                  { name: "pubspec.yaml", path: "pubspec.yaml", kind: "file", size: 100 },
                  { name: "lib", path: "lib", kind: "directory", size: 0 },
                ],
              },
              metadata: {
                category: "tool_observation",
                summary: "listed Flutter project root",
                retryable: false,
                toolName,
              },
            };
          }
          return {
            action: next.action,
            ok: true,
            output: { path: "pubspec.yaml", content: "name: watermeter\n" },
            metadata: {
              category: "tool_observation",
              summary: "read pubspec.yaml",
              retryable: false,
              toolName,
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    2,
  );

  assert.deepEqual(dispatchedTools, ["list_directory", "read_text_file"]);
  assert.equal(state.history[1]?.action.toolName, "read_text_file");
  assert.deepEqual(state.history[1]?.action.toolInput, { path: "pubspec.yaml" });
});

test("runLoop recovers repeated web fetches with search instead of local file tools", async () => {
  const repeatedFetch: BrainDecision = {
    action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/article" } },
    reasoning: "Model keeps fetching the same weak article page.",
  };
  const dispatchedTools: string[] = [];

  const state = await runLoop(
    {
      context: makeContext("看一下 https://example.test/article 的正文"),
      runId: "run_web_fetch_recovery",
      priorTurns: [],
      history: [{
        action: repeatedFetch.action,
        ok: true,
        output: { url: "https://example.test/article", text: "" },
        metadata: { category: "tool_observation", summary: "fetched weak page", retryable: false, toolName: "web_fetch" },
      }],
      workingMemory: {
        step: 1,
        phase: "investigate",
        lastActionKind: "tool_call",
        taskLoop: {
          objective: "看一下 https://example.test/article 的正文",
          mode: "web",
          evidenceCount: 1,
          completionGateCount: 0,
          currentTaskId: "analyze_evidence",
          tasks: [{
            id: "analyze_evidence",
            title: "提取网页正文",
            status: "active",
            criteria: [{ id: "body_evidence", description: "已拿到正文", status: "pending" }],
            attempts: 1,
          }],
        },
      },
      availableTools: [
        { name: "web_fetch", description: "Fetch web page", inputSchema: { type: "object" }, risk: "read" },
        { name: "web_search", description: "Search web", inputSchema: { type: "object" }, risk: "read" },
        { name: "read_text_file", description: "Read file", inputSchema: { type: "object" }, risk: "read" },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return repeatedFetch;
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          dispatchedTools.push(next.action.toolName ?? "");
          return {
            action: next.action,
            ok: true,
            output: { query: "example article", results: [{ title: "Article mirror", url: "https://mirror.example.test/article" }] },
            metadata: { category: "tool_observation", summary: "searched alternate source", retryable: false, toolName: next.action.toolName },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    2,
  );

  assert.equal(dispatchedTools[0], "web_search");
  assert.equal(state.history[1]?.action.toolName, "web_search");
});

test("runLoop summarizes collected evidence instead of repeating read-only tools without recovery", async () => {
  const repeatedList: BrainDecision = {
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    reasoning: "Model keeps listing the same directory.",
  };
  const seededList: ActionResult = {
    action: repeatedList.action,
    ok: true,
    output: { entries: [] },
    metadata: {
      category: "tool_observation",
      summary: "Listed the workspace root.",
      retryable: false,
      toolName: "list_directory",
    },
  };

  let dispatcherCalls = 0;
  const state = await runLoop(
    {
      context: makeContext("inspect this folder"),
      runId: "run_readonly_final_feedback",
      priorTurns: [],
      history: [seededList],
      workingMemory: {
        step: 1,
        phase: "investigate",
        lastActionKind: "tool_call",
        lastToolName: "list_directory",
      },
      availableTools: [
        {
          name: "list_directory",
          description: "List a directory",
          inputSchema: { type: "object" },
          risk: "read",
        },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return repeatedList;
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          assert.equal(next.action.kind, "respond");
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          dispatcherCalls += 1;
          assert.equal(next.action.kind, "respond");
          return {
            action: next.action,
            ok: true,
            output: next.action.content,
            metadata: {
              category: "assistant_response",
              summary: "Read-only feedback sent.",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(decision) {
          assert.equal(decision.action.kind, "respond");
          return { kind: "stop", reason: "respond" } as const;
        },
      },
    },
    3,
  );

  assert.equal(dispatcherCalls, 1);
  assert.equal(state.stopReason, "respond");
  assert.match(String(state.lastResult?.output), /list_directory/);
  assert.match(String(state.lastResult?.output), /Listed the workspace root/);
});

test("runLoop tracks task-loop evidence and final-answer readiness", async () => {
  const decisions: BrainDecision[] = [
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
      reasoning: "Read the requested file.",
    },
  ];

  const state = await runLoop(
    {
      context: makeContext("analyze README.md"),
      runId: "run_task_loop_memory",
      priorTurns: [],
      history: [],
      availableTools: [
        {
          name: "read_text_file",
          description: "Read a file",
          inputSchema: { type: "object" },
          risk: "read",
        },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decisions.shift() ?? { action: { kind: "respond", content: "done" } };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          if (next.action.kind === "respond") {
            return {
              action: next.action,
              ok: true,
              output: next.action.content,
              metadata: { category: "assistant_response", summary: "done", retryable: false },
            };
          }

          return {
            action: next.action,
            ok: true,
            output: { path: "README.md", content: "# Project\nDetails" },
            metadata: {
              category: "tool_observation",
              summary: "Read README.md",
              retryable: false,
              toolName: "read_text_file",
            },
          };
        },
      },
      evaluator: {
        async evaluate(_decision, result) {
          return result?.action.kind === "respond"
            ? { kind: "stop", reason: "respond" } as const
            : { kind: "continue" } as const;
        },
      },
    },
    1,
  );

  assert.equal(state.workingMemory.taskLoop?.objective, "analyze README.md");
  assert.equal(state.workingMemory.taskLoop?.mode, "workspace");
  assert.equal(state.workingMemory.taskLoop?.evidenceCount, 1);
  assert.equal(state.workingMemory.taskLoop?.lastEvidenceKind, "file");
  assert.equal(state.workingMemory.taskLoop?.lastEvidenceTool, "read_text_file");
  assert.equal(state.workingMemory.taskLoop?.lastEvidenceTarget, "README.md");
  assert.equal(state.workingMemory.taskLoop?.needsFinalAnswer, true);
});

test("runLoop does not block key file reads just because workspace task-loop reached answer phase", async () => {
  const codeMapResult: ActionResult = {
    action: { kind: "tool_call", toolName: "code_map", toolInput: { maxFiles: 1200 } },
    ok: true,
    output: { entrypoints: ["lib/main.dart"], fileStats: { filesScanned: 80 } },
    metadata: {
      category: "tool_observation",
      summary: "mapped project structure",
      retryable: false,
      toolName: "code_map",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("继续分析这个项目"),
      runId: "run_answer_phase_still_needs_file_evidence",
      priorTurns: [],
      history: [codeMapResult],
      workingMemory: {
        step: 1,
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
              title: "基于已检查证据说明结论",
              status: "active",
              criteria: [{ id: "final_feedback", description: "final answer", status: "pending" }],
              attempts: 0,
            },
          ],
          needsFinalAnswer: false,
        },
      },
      availableTools: [
        { name: "read_text_file", description: "Read file", inputSchema: { type: "object" }, risk: "read" },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return {
            action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "lib/main.dart" } },
            reasoning: "Need entrypoint evidence before final project feedback.",
          };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          assert.equal(next.action.kind, "tool_call");
          assert.equal(next.action.toolName, "read_text_file");
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          return {
            action: next.action,
            ok: true,
            output: { path: "lib/main.dart", content: "void main() {}\n" },
            metadata: {
              category: "tool_observation",
              summary: "read lib/main.dart",
              retryable: false,
              toolName: "read_text_file",
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    2,
  );

  assert.equal(state.lastResult?.action.kind, "tool_call");
  assert.equal(state.lastResult?.action.toolName, "read_text_file");
  assert.equal(state.workingMemory.taskLoop?.lastEvidenceTool, "read_text_file");
});

test("runLoop advances the task-loop plan after read-only evidence", async () => {
  const state = await runLoop(
    {
      context: makeContext("analyze README.md"),
      runId: "run_task_loop_plan_read",
      priorTurns: [],
      history: [],
      availableTools: [
        {
          name: "read_text_file",
          description: "Read a file",
          inputSchema: { type: "object" },
          risk: "read",
        },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return {
            action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
            reasoning: "Read the requested file.",
          };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          return {
            action: next.action,
            ok: true,
            output: { path: "README.md", content: "# Project\nDetails" },
            metadata: {
              category: "tool_observation",
              summary: "Read README.md",
              retryable: false,
              toolName: "read_text_file",
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    1,
  );

  assert.equal(state.workingMemory.taskLoop?.currentStep, "answer");
  assert.deepEqual(state.workingMemory.taskLoop?.plan?.map((item) => [item.id, item.status]), [
    ["collect_evidence", "done"],
    ["analyze_evidence", "done"],
    ["answer", "active"],
  ]);
  assert.equal(state.workingMemory.taskLoop?.currentTaskId, "answer");
  assert.equal(
    state.workingMemory.taskLoop?.tasks?.find((task) => task.id === "analyze_evidence")?.criteria[0]?.status,
    "satisfied",
  );
});

test("runLoop advances the task-loop plan from edit to validation", async () => {
  const decisions: BrainDecision[] = [
    {
      action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "star.py", content: "print('*')\n" } },
      reasoning: "Create the requested file.",
    },
  ];

  const state = await runLoop(
    {
      context: makeContext("build star.py"),
      runId: "run_task_loop_plan_edit",
      priorTurns: [],
      history: [],
      availableTools: [
        {
          name: "write_text_file",
          description: "Write a file",
          inputSchema: { type: "object" },
          effects: { workspaceMutation: true, validationMode: "all" },
        },
        {
          name: "run_validation",
          description: "Validate workspace",
          inputSchema: { type: "object" },
        },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decisions.shift() ?? { action: { kind: "respond", content: "done" } };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          const toolName = next.action.toolName;
          return {
            action: next.action,
            ok: true,
            output: toolName === "run_validation" ? { ok: true, mode: "all" } : { path: "star.py" },
            metadata: {
              category: "tool_observation",
              summary: toolName === "run_validation" ? "Validation passed." : "Wrote star.py",
              retryable: false,
              toolName,
              ...(toolName === "write_text_file" ? { workspaceMutation: true, validationMode: "all" as const } : {}),
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    1,
  );

  assert.equal(state.workingMemory.taskLoop?.currentStep, "verify");
  assert.deepEqual(state.workingMemory.taskLoop?.plan?.map((item) => [item.id, item.status]), [
    ["collect_evidence", "done"],
    ["apply_change", "done"],
    ["verify", "active"],
    ["answer", "pending"],
  ]);
  assert.equal(state.workingMemory.taskLoop?.currentTaskId, "verify");
  assert.equal(
    state.workingMemory.taskLoop?.tasks?.find((task) => task.id === "apply_change")?.criteria[0]?.status,
    "satisfied",
  );
});

test("runLoop maps web search and fetch results into task criteria", async () => {
  const decisions: BrainDecision[] = [
    {
      action: { kind: "tool_call", toolName: "web_search", toolInput: { query: "red books" } },
      reasoning: "Search the requested web topic.",
    },
    {
      action: { kind: "tool_call", toolName: "web_fetch", toolInput: { url: "https://example.test/article" } },
      reasoning: "Fetch the candidate article.",
    },
  ];

  const state = await runLoop(
    {
      context: makeContext("联网搜索红色书籍并看看正文"),
      runId: "run_task_loop_web_criteria",
      priorTurns: [],
      history: [],
      availableTools: [
        { name: "web_search", description: "Search web", inputSchema: { type: "object" } },
        { name: "web_fetch", description: "Fetch web page", inputSchema: { type: "object" } },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decisions.shift() ?? { action: { kind: "respond", content: "done" } };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          const toolName = next.action.toolName;
          return {
            action: next.action,
            ok: true,
            output: toolName === "web_fetch"
              ? { url: "https://example.test/article", text: "这是一段已经抽取出来的网页正文。".repeat(20) }
              : { query: "red books", results: [{ title: "红色书籍", url: "https://example.test/article" }] },
            metadata: {
              category: "tool_observation",
              summary: toolName === "web_fetch" ? "Fetched article body." : "Found candidate article.",
              retryable: false,
              toolName,
            },
          };
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "continue" } as const;
        },
      },
    },
    2,
  );

  assert.equal(state.workingMemory.taskLoop?.currentTaskId, "answer");
  assert.equal(
    state.workingMemory.taskLoop?.tasks?.find((task) => task.id === "collect_evidence")?.criteria[0]?.status,
    "satisfied",
  );
  assert.equal(
    state.workingMemory.taskLoop?.tasks?.find((task) => task.id === "analyze_evidence")?.criteria[0]?.status,
    "satisfied",
  );
});

test("runLoop unblocks task-loop target evidence after recovery discovery", async () => {
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
  const workingMemory = applyActionResultToWorkingMemory(
    {
      step: 0,
      phase: "investigate",
      taskLoop: {
        objective: "修改 src/missing.ts",
        mode: "edit",
        evidenceCount: 0,
        completionGateCount: 0,
        currentStep: "collect_evidence",
        plan: [
          { id: "collect_evidence", title: "Inspect", status: "active" },
          { id: "apply_change", title: "Apply", status: "pending" },
        ],
        currentTaskId: "collect_evidence",
        tasks: [
          {
            id: "collect_evidence",
            title: "Inspect the target file or failing diagnostic",
            status: "active",
            criteria: [{ id: "target_evidence", description: "target", status: "pending" }],
            attempts: 0,
          },
          {
            id: "apply_change",
            title: "Apply one focused workspace change",
            status: "pending",
            dependsOn: ["collect_evidence"],
            criteria: [{ id: "workspace_mutated", description: "mutate", status: "pending" }],
            attempts: 0,
          },
        ],
      },
      lastActionKind: null,
    },
    1,
    failedRead,
  );

  const recovered = applyActionResultToWorkingMemory(
    workingMemory,
    2,
    {
      action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: "src/missing.ts" } },
      ok: true,
      output: { results: [{ file: "src/app.ts", line: 1 }] },
      metadata: {
        category: "tool_observation",
        summary: "found src/app.ts",
        retryable: false,
        toolName: "search_workspace",
      },
    },
  );

  assert.equal(recovered.taskLoop?.tasks?.find((task) => task.id === "collect_evidence")?.status, "done");
  assert.equal(recovered.taskLoop?.tasks?.find((task) => task.id === "collect_evidence")?.criteria[0]?.status, "satisfied");
  assert.equal(recovered.taskLoop?.currentTaskId, "apply_change");
});

test("runLoop tracks the latest validation failure in working memory", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "typecheck" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "typecheck",
      commands: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          ok: false,
          exitCode: 2,
          stdout: "stdout: checking src/app.ts",
          stderr: "src/app.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
        },
      ],
      summary: "Validation typecheck failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation typecheck failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const input: BrainInput = {
    context: makeContext("fix the typecheck failure"),
    runId: "run_validation_failure",
    priorTurns: [],
    history: [],
    availableTools: [],
  };

  const state = await runLoop(
    input,
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return decision;
        },
      },
      policy: {
        async check(next: BrainDecision): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(): Promise<ActionResult> {
          return result;
        },
      },
      evaluator: {
        async evaluate() {
          return { kind: "stop", reason: "finish" } as const;
        },
      },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "typecheck",
    failingCommands: ["typecheck"],
    summary: "Validation typecheck failed.",
    stdoutSnippet: "stdout: checking src/app.ts",
    stderrSnippet: "src/app.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
    suspectFile: "src/app.ts",
    suspectLine: 1,
    suspectColumn: 7,
    suspectErrorCode: "TS2322",
  });
  assert.deepEqual(state.workingMemory.repairAttempt, {
    suspectFile: "src/app.ts",
    validationFailureCount: 1,
    editAttemptCount: 0,
    exhausted: false,
  });
  assert.equal(state.workingMemory.phase, "edit");
});

test("runLoop switches repeated validation failures on the same suspect back to investigate", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "typecheck" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "typecheck",
      commands: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          ok: false,
          exitCode: 2,
          stdout: "",
          stderr: "src/app.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
        },
      ],
      summary: "Validation typecheck failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation typecheck failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the typecheck failure"),
      runId: "run_repeated_validation_failure",
      priorTurns: [],
      history: [],
      workingMemory: {
        step: 2,
        phase: "validate",
        lastActionKind: "tool_call",
        lastToolName: "patch_text_file",
        validationFailure: {
          mode: "typecheck",
          failingCommands: ["typecheck"],
          summary: "Validation typecheck failed.",
          suspectFile: "src/app.ts",
          suspectErrorCode: "TS2322",
        },
        repairAttempt: {
          suspectFile: "src/app.ts",
          validationFailureCount: 1,
          editAttemptCount: 1,
          exhausted: false,
        },
      },
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    3,
  );

  assert.equal(state.workingMemory.phase, "investigate");
  assert.deepEqual(state.workingMemory.repairAttempt, {
    suspectFile: "src/app.ts",
    validationFailureCount: 2,
    editAttemptCount: 1,
    exhausted: true,
  });
});

test("runLoop advances working memory to validate after a successful file mutation", async () => {
  const decision: BrainDecision = {
    action: {
      kind: "tool_call",
      toolName: "patch_text_file",
      toolInput: {
        path: "src/app.ts",
        oldString: "const value = 1;",
        newString: "const value = 1;",
      },
    },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: { path: "src/app.ts", replacements: 1, bytes: 16 },
    metadata: {
      category: "tool_observation",
      summary: "patched src/app.ts",
      retryable: false,
      toolName: "patch_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the typecheck failure"),
      runId: "run_mutation_to_validate",
      priorTurns: [],
      history: [],
      workingMemory: {
        step: 0,
        phase: "edit",
        lastActionKind: null,
      },
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.equal(state.workingMemory.phase, "validate");
  assert.equal(state.workingMemory.lastToolName, "patch_text_file");
});

test("runLoop records the last attempted repair strategy and patch signature", async () => {
  const decision: BrainDecision = {
    action: {
      kind: "tool_call",
      toolName: "patch_text_file",
      toolInput: {
        path: "src/app.ts",
        oldString: "const value: number = \"123\";",
        newString: "const value: number = 123;",
      },
    },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: { path: "src/app.ts", replacements: 1, bytes: 30 },
    metadata: {
      category: "tool_observation",
      summary: "patched src/app.ts",
      retryable: false,
      toolName: "patch_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the typecheck failure"),
      runId: "run_record_repair_signature",
      priorTurns: [],
      history: [],
      workingMemory: {
        step: 0,
        phase: "edit",
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "typecheck",
          failingCommands: ["typecheck"],
          summary: "Validation typecheck failed.",
          suspectFile: "src/app.ts",
          suspectErrorCode: "TS2322",
        },
        repairAttempt: {
          suspectFile: "src/app.ts",
          validationFailureCount: 1,
          editAttemptCount: 0,
          exhausted: false,
        },
      },
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.repairAttempt, {
    suspectFile: "src/app.ts",
    validationFailureCount: 1,
    editAttemptCount: 1,
    exhausted: false,
    lastStrategy: "synthesized TS2322 number-literal fix",
    lastPatchSignature: JSON.stringify({
      tool: "patch_text_file",
      path: "src/app.ts",
      oldString: "const value: number = \"123\";",
      newString: "const value: number = 123;",
    }),
  });
});

test("runLoop can go edit to validate to summarize without premature finish", async () => {
  const availableTools: ToolDescriptor[] = [
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
    },
    {
      name: "run_validation",
      description: "Runs validation",
      inputSchema: { type: "object" },
    },
  ];
  const seededRead: ActionResult = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
    ok: true,
    output: { path: "src/app.ts", content: "const value: number = \"123\";\n" },
    metadata: {
      category: "tool_observation",
      summary: "read src/app.ts",
      retryable: false,
      toolName: "read_text_file",
    },
  };
  const actions: string[] = [];

  const state = await runLoop(
    {
      context: makeContext("fix the validation failure in src/app.ts"),
      runId: "run_edit_validate_summarize",
      priorTurns: [],
      history: [seededRead],
      workingMemory: {
        step: 1,
        phase: "edit",
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "typecheck",
          failingCommands: ["typecheck"],
          summary: "Validation typecheck failed.",
          stderrSnippet: "src/app.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
          suspectFile: "src/app.ts",
          suspectLine: 1,
          suspectErrorCode: "TS2322",
        },
      },
      availableTools,
    },
    {
      planner: new RulePlanner(),
      policy: { async check(next) { return next; } },
      dispatcher: {
        async dispatch(decision): Promise<ActionResult> {
          const toolName = decision.action.toolName ?? decision.action.kind;
          actions.push(toolName);

          if (decision.action.toolName === "patch_text_file") {
            assert.deepEqual(decision.action.toolInput, {
              path: "src/app.ts",
              oldString: "const value: number = \"123\";",
              newString: "const value: number = 123;",
            });
            return {
              action: decision.action,
              ok: true,
              output: { path: "src/app.ts", replacements: 1, bytes: 30 },
              metadata: {
                category: "tool_observation",
                summary: "patched src/app.ts",
                retryable: false,
                toolName: "patch_text_file",
                workspaceMutation: true,
                validationMode: "all",
              },
            };
          }

          if (decision.action.toolName === "run_validation") {
            return {
              action: decision.action,
              ok: true,
              output: { ok: true, mode: "all", summary: "Validation passed." },
              metadata: {
                category: "tool_observation",
                summary: "Validation passed.",
                retryable: false,
                toolName: "run_validation",
              },
            };
          }

          return {
            action: decision.action,
            ok: true,
            output: decision.action.content ?? "",
            metadata: {
              category: "assistant_response",
              summary: decision.action.content ?? "",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(_decision, result) {
          return result?.metadata?.category === "assistant_response"
            ? { kind: "stop", reason: "finish" } as const
            : { kind: "continue" } as const;
        },
      },
    },
    5,
  );

  assert.deepEqual(actions, ["patch_text_file", "run_validation", "respond"]);
  assert.equal(state.stopReason, "finish");
  assert.equal(state.workingMemory.phase, "summarize");
  assert.equal(state.history.length, 5);
  assert.equal(state.history.some((result) => result.action.kind === "tool_call" && result.action.toolName === "completion_check"), true);
});

test("runLoop continues from seeded history without replaying the approved tool step", async () => {
  const seededResult: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "note.txt", content: "ok" } },
    ok: true,
    output: { ok: true },
    metadata: {
      category: "tool_observation",
      summary: "File written.",
      retryable: false,
      toolName: "write_text_file",
    },
  };

  const followupDecision: BrainDecision = {
    action: { kind: "respond", content: "done" },
  };

  let plannerCalls = 0;
  let dispatcherCalls = 0;
  let evaluatorCalls = 0;

  const state = await runLoop(
    {
      context: makeContext("write note.txt then confirm completion"),
      runId: "run_seeded_resume",
      priorTurns: [],
      history: [seededResult],
      workingMemory: {
        step: 1,
        lastActionKind: "tool_call",
      },
      availableTools: [],
    },
    {
      planner: {
        async decide(input): Promise<BrainDecision> {
          plannerCalls += 1;
          assert.equal(input.history.length, 1);
          assert.equal(input.history[0]?.metadata?.toolName, "write_text_file");
          return followupDecision;
        },
      },
      policy: {
        async check(next: BrainDecision): Promise<BrainDecision> {
          return next;
        },
      },
      dispatcher: {
        async dispatch(decision): Promise<ActionResult> {
          dispatcherCalls += 1;
          assert.deepEqual(decision, followupDecision);
          return {
            action: decision.action,
            ok: true,
            output: "done",
            metadata: {
              category: "assistant_response",
              summary: "Responded to user.",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(_decision, _result, history) {
          evaluatorCalls += 1;
          const seenHistory = history ?? [];
          assert.equal(seenHistory.length, 2);
          return { kind: "stop", reason: "finish" } as const;
        },
      },
    },
    2,
  );

  assert.equal(plannerCalls, 1);
  assert.equal(dispatcherCalls, 1);
  assert.equal(evaluatorCalls, 1);
  assert.equal(state.steps, 2);
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0]?.metadata?.toolName, "write_text_file");
  assert.equal(state.lastResult?.output, "done");
});

test("runLoop stops duplicate approved workspace mutation instead of requesting approval again", async () => {
  const duplicateWrite: BrainDecision = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "christmas_tree.py", content: "print('ok')\n" } },
    reasoning: "Model repeated the same write after approval.",
  };

  const seededWrite: ActionResult = {
    action: duplicateWrite.action,
    ok: true,
    output: { path: "christmas_tree.py", bytes: 12 },
    metadata: {
      category: "tool_observation",
      summary: "File written.",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };

  const seededValidation: ActionResult = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "all" } },
    ok: true,
    output: { ok: true, mode: "all", summary: "Validation passed." },
    metadata: {
      category: "tool_observation",
      summary: "Validation passed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  let policyCalls = 0;
  let dispatcherCalls = 0;
  let plannerCalls = 0;

  const state = await runLoop(
    {
      context: makeContext("create christmas_tree.py"),
      runId: "run_duplicate_approval",
      priorTurns: [],
      history: [seededWrite, seededValidation],
      workingMemory: {
        step: 2,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
      },
      availableTools: [
        { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write" },
        { name: "run_validation", description: "validate", inputSchema: {}, risk: "execute", requiresApproval: false, capability: "process.validate" },
      ],
    },
    {
      planner: {
        async decide(input): Promise<BrainDecision> {
          plannerCalls += 1;
          const lastResult = input.history[input.history.length - 1];
          if (lastResult?.action.kind === "tool_call" && lastResult.action.toolName === "completion_check") {
            return {
              action: { kind: "respond", content: "工作已完成：christmas_tree.py 已写入，并且验证已通过。" },
              reasoning: "Planner made a final completion judgment from completion_check.",
            };
          }
          return duplicateWrite;
        },
      },
      policy: {
        async check(next: BrainDecision): Promise<BrainDecision> {
          policyCalls += 1;
          assert.equal(next.action.kind, "respond");
          assert.notEqual(next.action.kind, "needs_approval");
          return next;
        },
      },
      dispatcher: {
        async dispatch(decision): Promise<ActionResult> {
          dispatcherCalls += 1;
          assert.equal(decision.action.kind, "respond");
          return {
            action: decision.action,
            ok: true,
            output: decision.action.content ?? "done",
            metadata: {
              category: "assistant_response",
              summary: "Completion feedback sent.",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(decision) {
          assert.equal(decision.action.kind, "respond");
          return { kind: "stop", reason: "respond" } as const;
        },
      },
    },
    5,
  );

  assert.equal(plannerCalls, 1);
  assert.equal(policyCalls, 1);
  assert.equal(dispatcherCalls, 1);
  assert.equal(state.stopReason, "respond");
  assert.match(String(state.lastResult?.output), /已完成/);
  assert.match(String(state.lastResult?.output), /christmas_tree\.py/);
  assert.doesNotMatch(String(state.lastResult?.output), /Skipped duplicate/);
  assert.equal(state.history.some((result) => result.action.kind === "tool_call" && result.action.toolName === "completion_check"), true);
});

test("runLoop validates instead of repeating a model-emitted approval request", async () => {
  const duplicateApproval: BrainDecision = {
    action: {
      kind: "needs_approval",
      toolName: "write_text_file",
      toolInput: { path: "christmas_tree.py", content: "print('ok')\n" },
      reason: "Model requested approval for the same write again.",
    },
    reasoning: "The model repeated a previous approval request.",
  };

  const seededWrite: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "christmas_tree.py", content: "print('ok')\n" } },
    ok: true,
    output: { path: "christmas_tree.py", bytes: 12 },
    metadata: {
      category: "tool_observation",
      summary: "File written.",
      retryable: false,
      toolName: "write_text_file",
    },
  };

  let policyCalls = 0;
  let dispatcherCalls = 0;

  const state = await runLoop(
    {
      context: makeContext("create christmas_tree.py"),
      runId: "run_duplicate_model_approval",
      priorTurns: [],
      history: [seededWrite],
      workingMemory: {
        step: 1,
        lastActionKind: "tool_call",
        lastToolName: "write_text_file",
      },
      availableTools: [
        { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write", effects: { workspaceMutation: true, validationMode: "all" } },
        { name: "run_validation", description: "validate", inputSchema: {}, risk: "execute", requiresApproval: false, capability: "process.validate" },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return duplicateApproval;
        },
      },
      policy: {
        async check(next: BrainDecision): Promise<BrainDecision> {
          policyCalls += 1;
          assert.equal(next.action.kind, "tool_call");
          assert.equal(next.action.toolName, "run_validation");
          return next;
        },
      },
      dispatcher: {
        async dispatch(decision): Promise<ActionResult> {
          dispatcherCalls += 1;
          assert.equal(decision.action.kind, "tool_call");
          assert.equal(decision.action.toolName, "run_validation");
          return {
            action: decision.action,
            ok: true,
            output: { ok: true, mode: "all", summary: "Validation passed." },
            metadata: {
              category: "tool_observation",
              summary: "Validation passed.",
              retryable: false,
              toolName: "run_validation",
            },
          };
        },
      },
      evaluator: {
        async evaluate(decision) {
          assert.equal(decision.action.kind, "tool_call");
          assert.equal(decision.action.toolName, "run_validation");
          return { kind: "stop", reason: "finish" } as const;
        },
      },
    },
    3,
  );

  assert.equal(policyCalls, 1);
  assert.equal(dispatcherCalls, 1);
  assert.equal(state.stopReason, "finish");
  assert.equal(state.lastDecision?.action.toolName, "run_validation");
});

test("runLoop inserts completion_check after successful validation before final feedback", async () => {
  const seededWrite: ActionResult = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "star.py", content: "print('*')\n" } },
    ok: true,
    output: { path: "star.py", bytes: 11 },
    metadata: {
      category: "tool_observation",
      summary: "File written.",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };
  const seededValidation: ActionResult = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "all" } },
    ok: true,
    output: { ok: true, mode: "all", summary: "Fallback validation passed." },
    metadata: {
      category: "tool_observation",
      summary: "Validation passed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  let plannerCalls = 0;

  const state = await runLoop(
    {
      context: makeContext("create star.py"),
      runId: "run_completion_gate",
      priorTurns: [],
      history: [seededWrite, seededValidation],
      workingMemory: {
        step: 2,
        phase: "summarize",
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
      },
      availableTools: [
        { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write", effects: { workspaceMutation: true, validationMode: "all" } },
        { name: "run_validation", description: "validate", inputSchema: {}, risk: "execute", requiresApproval: false, capability: "process.validate" },
      ],
    },
    {
      planner: {
        async decide(input): Promise<BrainDecision> {
          plannerCalls += 1;
          const lastResult = input.history[input.history.length - 1];
          assert.equal(lastResult?.action.kind, "tool_call");
          assert.equal(lastResult?.action.toolName, "completion_check");
          return {
            action: { kind: "respond", content: "工作已完成：star.py 已写入，并且验证已通过。" },
            reasoning: "Planner finalized from completion_check.",
          };
        },
      },
      policy: {
        async check(next): Promise<BrainDecision> {
          assert.equal(next.action.kind, "respond");
          return next;
        },
      },
      dispatcher: {
        async dispatch(next): Promise<ActionResult> {
          assert.equal(next.action.kind, "respond");
          return {
            action: next.action,
            ok: true,
            output: next.action.content,
            metadata: {
              category: "assistant_response",
              summary: "Final feedback sent.",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(decision) {
          assert.equal(decision.action.kind, "respond");
          return { kind: "stop", reason: "respond" } as const;
        },
      },
    },
    6,
  );

  const completionCheck = state.history.find((result) => result.action.kind === "tool_call" && result.action.toolName === "completion_check");
  assert.equal(plannerCalls, 1);
  assert.ok(completionCheck);
  assert.equal((completionCheck.output as { repeatedActionPrevented?: unknown }).repeatedActionPrevented, false);
  assert.equal(state.stopReason, "respond");
  assert.match(String(state.lastResult?.output), /star\.py/);
  assert.doesNotMatch(String(state.lastResult?.output), /重复/);
});

test("runLoop finalizes a dangling completion_check with user feedback at the step limit", async () => {
  const duplicateWrite: BrainDecision = {
    action: { kind: "tool_call", toolName: "write_text_file", toolInput: { path: "christmas_tree.py", content: "print('ok')\n" } },
    reasoning: "Model repeated the same write at the end of the step budget.",
  };

  const seededWrite: ActionResult = {
    action: duplicateWrite.action,
    ok: true,
    output: { path: "christmas_tree.py", bytes: 12 },
    metadata: {
      category: "tool_observation",
      summary: "File written.",
      retryable: false,
      toolName: "write_text_file",
      workspaceMutation: true,
      validationMode: "all",
    },
  };

  const seededValidation: ActionResult = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "all" } },
    ok: true,
    output: { ok: true, mode: "all", summary: "Validation passed." },
    metadata: {
      category: "tool_observation",
      summary: "Validation passed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("create christmas_tree.py"),
      runId: "run_dangling_completion_check",
      priorTurns: [],
      history: [seededWrite, seededValidation],
      workingMemory: {
        step: 2,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
      },
      availableTools: [
        { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write" },
        { name: "run_validation", description: "validate", inputSchema: {}, risk: "execute", requiresApproval: false, capability: "process.validate" },
      ],
    },
    {
      planner: {
        async decide(): Promise<BrainDecision> {
          return duplicateWrite;
        },
      },
      policy: {
        async check(): Promise<BrainDecision> {
          throw new Error("policy should not be called for an injected completion_check");
        },
      },
      dispatcher: {
        async dispatch(): Promise<ActionResult> {
          throw new Error("dispatcher should not be called for an injected completion_check");
        },
      },
      evaluator: {
        async evaluate() {
          throw new Error("evaluator should not be called for an injected completion_check");
        },
      },
    },
    3,
  );

  assert.equal(state.stopReason, "respond");
  assert.equal(state.lastDecision?.action.kind, "respond");
  assert.equal(state.lastResult?.metadata?.syntheticFinalFeedback, true);
  assert.match(String(state.lastResult?.output), /christmas_tree\.py/);
  assert.match(String(state.lastResult?.output), /Validation passed/);
  assert.equal(state.history.some((result) => result.action.kind === "tool_call" && result.action.toolName === "completion_check"), true);
});

test("runLoop extracts TypeScript paren-format diagnostics from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "typecheck" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "typecheck",
      commands: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          ok: false,
          exitCode: 2,
          stdout: "",
          stderr: "src/lib/math.ts(12,34): error TS2554: Expected 2 arguments, but got 1.",
        },
      ],
      summary: "Validation typecheck failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation typecheck failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the typecheck failure"),
      runId: "run_validation_ts_paren_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "typecheck",
    failingCommands: ["typecheck"],
    summary: "Validation typecheck failed.",
    stderrSnippet: "src/lib/math.ts(12,34): error TS2554: Expected 2 arguments, but got 1.",
    suspectFile: "src/lib/math.ts",
    suspectLine: 12,
    suspectColumn: 34,
    suspectErrorCode: "TS2554",
  });
});

test("runLoop extracts specialized pytest failure hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            "============================= test session starts =============================",
            "FAILED tests/test_math.py::test_addition - AssertionError: assert 2 == 3",
            "tests/test_math.py:42: AssertionError",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_pytest_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "test",
    failingCommands: ["test"],
    summary: "Validation test failed.",
    stdoutSnippet: [
      "============================= test session starts =============================",
      "FAILED tests/test_math.py::test_addition - AssertionError: assert 2 == 3",
      "tests/test_math.py:42: AssertionError",
    ].join("\n"),
    failingTestName: "tests/test_math.py::test_addition",
    suspectFile: "tests/test_math.py",
    suspectLine: 42,
  });
});

test("runLoop prefers source stack frames over test frames and extracts assertion diffs", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/utils/math.test.ts > math utils > adds numbers",
            "AssertionError: expected 2 to be 3",
            "Expected: 3",
            "Received: 2",
            " ❯ src/lib/math.ts:8:11",
            " ❯ src/utils/math.test.ts:18:20",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_source_frame_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "test",
    failingCommands: ["test"],
    summary: "Validation test failed.",
    stdoutSnippet: [
      " FAIL  src/utils/math.test.ts > math utils > adds numbers",
      "AssertionError: expected 2 to be 3",
      "Expected: 3",
      "Received: 2",
      " ❯ src/lib/math.ts:8:11",
      " ❯ src/utils/math.test.ts:18:20",
    ].join("\n"),
    failingTestName: "src/utils/math.test.ts > math utils > adds numbers",
    suspectFile: "src/lib/math.ts",
    suspectLine: 8,
    suspectColumn: 11,
    assertExpected: "3",
    assertActual: "2",
    assertDiffSummary: "Expected 3 but received 2",
  });
});

test("runLoop prefers app source frames over node_modules and test frames", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > formats label",
            "AssertionError: expected rendered text to match",
            " ❯ node_modules/react-dom/cjs/react-dom-client.development.js:1234:56",
            " ❯ src/features/todo/format-label.ts:27:15",
            " ❯ src/features/todo/todo.test.ts:44:18",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_node_modules_frame_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "test",
    failingCommands: ["test"],
    summary: "Validation test failed.",
    stdoutSnippet: [
      " FAIL  src/features/todo/todo.test.ts > todo > formats label",
      "AssertionError: expected rendered text to match",
      " ❯ node_modules/react-dom/cjs/react-dom-client.development.js:1234:56",
      " ❯ src/features/todo/format-label.ts:27:15",
      " ❯ src/features/todo/todo.test.ts:44:18",
    ].join("\n"),
    failingTestName: "src/features/todo/todo.test.ts > todo > formats label",
    suspectFile: "src/features/todo/format-label.ts",
    suspectLine: 27,
    suspectColumn: 15,
  });
});

test("runLoop extracts multiline assertion diff summaries from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > serializes payload",
            "AssertionError: expected payload to match snapshot",
            "Expected: {",
            "  \"status\": \"done\",",
            "  \"count\": 3",
            "}",
            "Received: {",
            "  \"status\": \"pending\",",
            "  \"count\": 2",
            "}",
            " ❯ src/features/todo/serialize.ts:19:7",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_multiline_diff_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "test",
    failingCommands: ["test"],
    summary: "Validation test failed.",
    stdoutSnippet: [
      " FAIL  src/features/todo/todo.test.ts > todo > serializes payload",
      "AssertionError: expected payload to match snapshot",
      "Expected: {",
      "  \"status\": \"done\",",
      "  \"count\": 3",
      "}",
      "Received: {",
      "  \"status\": \"pending\",",
      "  \"count\": 2",
      "}",
      " ❯ src/features/todo/serialize.ts:19:7",
    ].join("\n"),
    failingTestName: "src/features/todo/todo.test.ts > todo > serializes payload",
    suspectFile: "src/features/todo/serialize.ts",
    suspectLine: 19,
    suspectColumn: 7,
    assertExpected: [
      "{",
      "  \"status\": \"done\",",
      "  \"count\": 3",
      "}",
    ].join("\n"),
    assertActual: [
      "{",
      "  \"status\": \"pending\",",
      "  \"count\": 2",
      "}",
    ].join("\n"),
    assertDiffSummary: 'Mismatched paths: status (expected "done", received "pending"), count (expected 3, received 2)',
  });
});

test("runLoop summarizes object diff keys and missing fields from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > normalizes payload",
            "AssertionError: expected payload to match shape",
            "Expected: {",
            "  \"status\": \"done\",",
            "  \"count\": 3,",
            "  \"owner\": \"alice\"",
            "}",
            "Received: {",
            "  \"status\": \"pending\",",
            "  \"count\": 2,",
            "  \"extra\": true",
            "}",
            " ❯ src/features/todo/normalize.ts:33:9",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_object_key_diff_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.equal(
    state.workingMemory.validationFailure?.assertDiffSummary,
    'Mismatched paths: status (expected "done", received "pending"), count (expected 3, received 2); Missing keys in actual: owner; Unexpected keys in actual: extra',
  );
});

test("runLoop summarizes nested object path diffs from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > normalizes nested payload",
            "AssertionError: expected payload to match shape",
            "Expected: {",
            "  \"user\": {",
            "    \"name\": \"Alice\",",
            "    \"stats\": {",
            "      \"count\": 3",
            "    }",
            "  }",
            "}",
            "Received: {",
            "  \"user\": {",
            "    \"name\": \"Bob\",",
            "    \"stats\": {",
            "      \"count\": 2",
            "    }",
            "  }",
            "}",
            " ❯ src/features/todo/normalize-nested.ts:18:5",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_nested_object_diff_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.equal(
    state.workingMemory.validationFailure?.assertDiffSummary,
    'Mismatched paths: user.name (expected "Alice", received "Bob"), user.stats.count (expected 3, received 2)',
  );
});

test("runLoop summarizes array diffs from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > normalizes item order",
            "AssertionError: expected payload to match shape",
            "Expected: [",
            "  \"todo\",",
            "  \"done\",",
            "  \"archived\"",
            "]",
            "Received: [",
            "  \"todo\",",
            "  \"pending\"",
            "]",
            " ❯ src/features/todo/normalize-array.ts:22:6",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_array_diff_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.equal(
    state.workingMemory.validationFailure?.assertDiffSummary,
    'Array diffs: [1] expected "done", received "pending"; Missing items in actual: [2]="archived"',
  );
});

test("runLoop summarizes snapshot style +/- diffs from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/features/todo/todo.test.ts > todo > renders snapshot",
            "AssertionError: expected snapshot to match",
            "-   \"status\": \"pending\",",
            "+   \"status\": \"done\",",
            "-   \"count\": 2,",
            "+   \"count\": 3,",
            "-   \"owner\": \"bob\",",
            "+   \"owner\": \"alice\",",
            " ❯ src/features/todo/render-snapshot.ts:14:4",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_snapshot_diff_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.equal(
    state.workingMemory.validationFailure?.assertDiffSummary,
    'Snapshot diffs: status (removed "pending", added "done"), count (removed 2, added 3), owner (removed "bob", added "alice")',
  );
});

test("runLoop extracts vitest-jest style failure hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "test" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "test",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/utils/math.test.ts > math utils > adds numbers",
            "AssertionError: expected 2 to be 3",
            " ❯ src/utils/math.test.ts:18:20",
          ].join("\n"),
          stderr: "",
        },
      ],
      summary: "Validation test failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation test failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the failing tests"),
      runId: "run_validation_vitest_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "test",
    failingCommands: ["test"],
    summary: "Validation test failed.",
    stdoutSnippet: [
      " FAIL  src/utils/math.test.ts > math utils > adds numbers",
      "AssertionError: expected 2 to be 3",
      " ❯ src/utils/math.test.ts:18:20",
    ].join("\n"),
    failingTestName: "src/utils/math.test.ts > math utils > adds numbers",
    suspectFile: "src/utils/math.test.ts",
    suspectLine: 18,
    suspectColumn: 20,
  });
});

test("runLoop extracts specialized build failure hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Could not resolve \"./missing.ts\" from \"src/main.ts\"\nerror during build:\nRollupError: Could not resolve \"./missing.ts\" from \"src/main.ts\"",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_build_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "Could not resolve \"./missing.ts\" from \"src/main.ts\"\nerror during build:\nRollupError: Could not resolve \"./missing.ts\" from \"src/main.ts\"",
    suspectFile: "src/main.ts",
    suspectImportPath: "./missing.ts",
  });
});

test("runLoop extracts module-not-found build hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Module not found: Error: Can't resolve '@/components/Button' in '/workspace/src/pages'",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_module_not_found_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "Module not found: Error: Can't resolve '@/components/Button' in '/workspace/src/pages'",
    suspectImportPath: "@/components/Button",
  });
});

test("runLoop extracts export-mismatch build hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "The requested module '/src/lib/api.ts' does not provide an export named 'fetchUser'",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_export_mismatch_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "The requested module '/src/lib/api.ts' does not provide an export named 'fetchUser'",
    suspectFile: "/src/lib/api.ts",
    suspectExportName: "fetchUser",
  });
});

test("runLoop ranks multiple failing commands and keeps the richest root-cause signal", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "all" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "all",
      commands: [
        {
          name: "test",
          command: "npm run test",
          ok: false,
          exitCode: 1,
          stdout: [
            " FAIL  src/utils/math.test.ts > math utils > adds numbers",
            "AssertionError: expected 2 to be 3",
            " ❯ src/utils/math.test.ts:18:20",
          ].join("\n"),
          stderr: "",
        },
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Module not found: Error: Can't resolve '@/components/Button' in '/workspace/src/pages'",
        },
      ],
      summary: "Validation all failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation all failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the validation failure"),
      runId: "run_validation_ranked_root_cause_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "all",
    failingCommands: ["test", "build"],
    summary: "Validation all failed.",
    stderrSnippet: "Module not found: Error: Can't resolve '@/components/Button' in '/workspace/src/pages'",
    suspectImportPath: "@/components/Button",
  });
});

test("runLoop extracts missing default export build hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Attempted import error: './api' does not contain a default export (imported as 'api').",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_default_export_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "Attempted import error: './api' does not contain a default export (imported as 'api').",
    suspectFile: "./api",
    suspectExportName: "default",
    suspectImportStyle: "default",
  });
});

test("runLoop extracts missing named export build hints from validation output", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "Attempted import error: 'sum' is not exported from './math' (imported as 'sum').",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_named_export_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "Attempted import error: 'sum' is not exported from './math' (imported as 'sum').",
    suspectFile: "./math",
    suspectExportName: "sum",
    suspectImportStyle: "named",
  });
});

test("runLoop normalizes webpack export-mismatch build hints", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "export 'fetchUser' (imported as 'fetchUser') was not found in './api' (possible exports: getUser, listUsers)",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_webpack_export_mismatch_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "export 'fetchUser' (imported as 'fetchUser') was not found in './api' (possible exports: getUser, listUsers)",
    suspectFile: "./api",
    suspectExportName: "fetchUser",
    suspectImportStyle: "named",
  });
});

test("runLoop normalizes esbuild export-mismatch build hints", async () => {
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: "build" } },
  };

  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: {
      ok: false,
      mode: "build",
      commands: [
        {
          name: "build",
          command: "npm run build",
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "✘ [ERROR] No matching export in \"src/lib/api.ts\" for import \"default\"",
        },
      ],
      summary: "Validation build failed.",
    },
    metadata: {
      category: "tool_observation",
      summary: "Validation build failed.",
      retryable: false,
      toolName: "run_validation",
    },
  };

  const state = await runLoop(
    {
      context: makeContext("fix the build failure"),
      runId: "run_validation_esbuild_export_mismatch_failure",
      priorTurns: [],
      history: [],
      availableTools: [],
    },
    {
      planner: { async decide() { return decision; } },
      policy: { async check(next) { return next; } },
      dispatcher: { async dispatch() { return result; } },
      evaluator: { async evaluate() { return { kind: "stop", reason: "finish" } as const; } },
    },
    1,
  );

  assert.deepEqual(state.workingMemory.validationFailure, {
    mode: "build",
    failingCommands: ["build"],
    summary: "Validation build failed.",
    stderrSnippet: "✘ [ERROR] No matching export in \"src/lib/api.ts\" for import \"default\"",
    suspectFile: "src/lib/api.ts",
    suspectExportName: "default",
    suspectImportStyle: "default",
  });
});

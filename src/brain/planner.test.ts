import { test } from "node:test";
import * as assert from "node:assert/strict";

import { LlmPlanner, RulePlanner } from "./planner.js";
import type { BrainInput, ActionResult, BrainDecision, WorkingMemorySnapshot } from "./types.js";
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

function makeInput(
  history: ActionResult[],
  availableTools: ToolDescriptor[],
  message = "please update the file",
  workingMemory?: WorkingMemorySnapshot,
): BrainInput {
  return {
    context: makeContext(message),
    runId: "run_1",
    priorTurns: [],
    history,
    ...(workingMemory ? { workingMemory } : {}),
    availableTools,
  };
}

function makeWorkspaceMutationResult(): ActionResult {
  return {
    action: { kind: "tool_call", toolName: "write_fixture", toolInput: { path: "src/app.ts" } },
    ok: true,
    output: { ok: true },
    metadata: {
      category: "tool_observation",
      summary: "updated src/app.ts",
      retryable: false,
      toolName: "write_fixture",
      workspaceMutation: true,
      validationMode: "all",
    },
  };
}

class RecordingModel {
  calls = 0;

  constructor(private readonly response: BrainDecision["action"]) {}

  async generateDecision(): Promise<{ action: BrainDecision["action"] }> {
    this.calls += 1;
    return { action: this.response };
  }
}

test("RulePlanner auto-runs validation after a successful workspace mutation", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "write_fixture",
      description: "Mutates a workspace file",
      inputSchema: { type: "object" },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
    },
    {
      name: "run_validation",
      description: "Runs validation scripts",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    makeWorkspaceMutationResult(),
  ], availableTools));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "run_validation",
    toolInput: { mode: "all" },
  });
});

test("RulePlanner does not auto-run validation after ordinary read-only tool output", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "run_validation",
      description: "Runs validation scripts",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "hello" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools));

  assert.equal(decision.action.kind, "respond");
  assert.match(decision.action.content ?? "", /src\/app\.ts/);
});

test("RulePlanner uses search_workspace first for generic change requests", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "fix validation error in src/app.ts"));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "search_workspace",
    toolInput: { query: "src/app.ts" },
  });
  assert.match(decision.reasoning ?? "", /Phase investigate/);
});

test("RulePlanner reads the top search hit before responding", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: "src/app.ts" } },
      ok: true,
      output: {
        query: "src/app.ts",
        results: [
          { file: "src/app.ts", line: 7, snippet: "const broken = true;" },
        ],
        truncated: false,
        filesScanned: 4,
      },
      metadata: {
        category: "tool_observation",
        summary: "found src/app.ts",
        retryable: false,
        toolName: "search_workspace",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "search_workspace",
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "read_text_file",
    toolInput: { path: "src/app.ts" },
  });
  assert.match(decision.reasoning ?? "", /Phase investigate/);
});

test("RulePlanner uses search_workspace first for read-only lookup requests", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "find the secret answer in this workspace and tell me the file and value"));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "search_workspace",
    toolInput: { query: "secret answer" },
  });
  assert.match(decision.reasoning ?? "", /Phase investigate/);
});

test("RulePlanner inspects projects for Chinese project lookup requests", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "inspect_project",
      description: "Inspects the project",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "看一下这个项目"));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "inspect_project",
    toolInput: {},
  });
  assert.match(decision.reasoning ?? "", /inspect_project/);
});

test("RulePlanner runs validation for Chinese runnable-project requests", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "run_validation",
      description: "Runs validation scripts",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "看一下这个项目能不能跑"));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "run_validation",
    toolInput: { mode: "all" },
  });
});

test("LlmPlanner falls back to safe deterministic tools when the model only responds", async () => {
  const model = new RecordingModel({ kind: "respond", content: "I can look at it." });
  const planner = new LlmPlanner(model);
  const availableTools: ToolDescriptor[] = [
    {
      name: "inspect_project",
      description: "Inspects the project",
      inputSchema: { type: "object" },
      requiresApproval: false,
      risk: "read",
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "看一下这个项目"));

  assert.equal(model.calls, 1);
  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "inspect_project",
    toolInput: {},
  });
  assert.match(decision.reasoning ?? "", /safe-tool fallback/);
});

test("RulePlanner falls back to list_directory after an empty search result", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "list_directory",
      description: "Lists files",
      inputSchema: { type: "object" },
    },
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: "secret answer" } },
      ok: true,
      output: {
        query: "secret answer",
        results: [],
        truncated: false,
        filesScanned: 3,
      },
      metadata: {
        category: "tool_observation",
        summary: "no matches for secret answer",
        retryable: false,
        toolName: "search_workspace",
      },
    },
  ], availableTools, "find the secret answer in this workspace and tell me the file and value", {
    step: 1,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "search_workspace",
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "list_directory",
    toolInput: { path: "." },
  });
  assert.match(decision.reasoning ?? "", /empty search result/i);
});

test("RulePlanner chooses patch_text_file in edit phase for a validation suspect file", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "const value: number = \"123\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 2,
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
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "patch_text_file",
    toolInput: {
      path: "src/app.ts",
      oldString: "const value: number = \"123\";",
      newString: "const value: number = 123;",
    },
  });
  const toolInput = decision.action.toolInput as { oldString: string; newString: string };
  assert.notEqual(toolInput.oldString, toolInput.newString);
  assert.match(decision.reasoning ?? "", /Phase edit/);
});

test("RulePlanner refuses to re-emit an identical deterministic patch after failed validation", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];
  const lastPatchSignature = JSON.stringify({
    tool: "patch_text_file",
    path: "src/app.ts",
    oldString: "const value: number = \"123\";",
    newString: "const value: number = 123;",
  });

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "const value: number = \"123\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 4,
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
    repairAttempt: {
      suspectFile: "src/app.ts",
      validationFailureCount: 1,
      editAttemptCount: 1,
      exhausted: false,
      lastStrategy: "patch_text_file",
      lastPatchSignature,
    },
  }));

  assert.equal(decision.action.kind, "fail");
  assert.match(decision.action.reason ?? "", /Refusing to repeat the same deterministic patch_text_file edit/);
  assert.match(decision.action.reason ?? "", /suspectFile=src\/app\.ts/);
  assert.match(decision.action.reason ?? "", /validationFailureCount=1/);
  assert.match(decision.action.reason ?? "", /editAttemptCount=1/);
  assert.match(decision.action.reason ?? "", /lastStrategy=patch_text_file/);
});

test("RulePlanner re-investigates the suspect file after repair attempts are exhausted", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([], availableTools, "fix validation error in src/app.ts", {
    step: 4,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "run_validation",
    validationFailure: {
      mode: "typecheck",
      failingCommands: ["typecheck"],
      summary: "Validation typecheck failed.",
      suspectFile: "src/app.ts",
      suspectLine: 1,
      suspectErrorCode: "TS2322",
    },
    repairAttempt: {
      suspectFile: "src/app.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "read_text_file",
    toolInput: { path: "src/app.ts" },
  });
  assert.match(decision.reasoning ?? "", /repair attempts exhausted/);
});

test("RulePlanner fails after exhausted re-investigation when no new concrete fix is available", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "const value = 123;\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 5,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "typecheck",
      failingCommands: ["typecheck", "test"],
      summary: "Validation failed.",
      suspectFile: "src/app.ts",
      suspectLine: 1,
    },
    repairAttempt: {
      suspectFile: "src/app.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      lastStrategy: "patch_text_file",
      lastPatchSignature: "previous-signature",
    },
  }));

  assert.equal(decision.action.kind, "fail");
  assert.match(decision.action.reason ?? "", /No new concrete deterministic fix/);
  assert.match(decision.action.reason ?? "", /suspectFile=src\/app\.ts/);
  assert.match(decision.action.reason ?? "", /failingCommands=typecheck, test/);
  assert.match(decision.action.reason ?? "", /validationFailureCount=2/);
  assert.match(decision.action.reason ?? "", /editAttemptCount=1/);
  assert.match(decision.action.reason ?? "", /lastStrategy=patch_text_file/);
});

test("RulePlanner pivots exhausted import failures to the related import path", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/main.ts" } },
      ok: true,
      output: { path: "src/main.ts", content: "import { fetchUser } from \"./api.ts\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/main.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 5,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      triedSuspectPaths: ["src/main.ts"],
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "read_text_file",
    toolInput: { path: "src/api.ts" },
  });
  assert.match(decision.reasoning ?? "", /alternate suspect path src\/api\.ts/);
});

test("RulePlanner chooses deterministic import/export edit on related suspect path", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/api.ts" } },
      ok: true,
      output: { path: "src/api.ts", content: "export default function fetchUser() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 6,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      triedSuspectPaths: ["src/main.ts"],
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "patch_text_file",
    toolInput: {
      path: "src/api.ts",
      oldString: "export default function fetchUser() {}",
      newString: "export function fetchUser() {}",
    },
  });
  assert.match(decision.reasoning ?? "", /suspect path src\/api\.ts/);
  assert.match(decision.reasoning ?? "", /import\/export style fix/);
});

test("RulePlanner fails only after alternate import/export suspect options are exhausted", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/main.ts" } },
      ok: true,
      output: { path: "src/main.ts", content: "import { fetchUser } from \"./api.ts\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/main.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/api.ts" } },
      ok: true,
      output: { path: "src/api.ts", content: "export function fetchUser() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 8,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 2,
      exhausted: true,
      lastStrategy: "synthesized import/export style fix",
      triedStrategies: ["synthesized import/export style fix"],
      triedSuspectPaths: ["src/main.ts", "src/api.ts"],
      triedStrategyPaths: ["synthesized import/export style fix@src/main.ts", "synthesized import/export style fix@src/api.ts"],
    },
  }));

  assert.equal(decision.action.kind, "fail");
  assert.match(decision.action.reason ?? "", /No new concrete deterministic fix/);
  assert.match(decision.action.reason ?? "", /triedSuspectPaths=src\/main\.ts, src\/api\.ts/);
  assert.match(decision.action.reason ?? "", /triedStrategyPaths=.*src\/api\.ts/);
});

test("RulePlanner searches workspace after exhausted direct suspect paths are consumed", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/main.ts" } },
      ok: true,
      output: { path: "src/main.ts", content: "import { fetchUser } from \"./api.ts\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/main.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/api.ts" } },
      ok: true,
      output: { path: "src/api.ts", content: "export function other() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 9,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      triedSuspectPaths: ["src/main.ts"],
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "search_workspace",
    toolInput: { query: "fetchUser" },
  });
  assert.match(decision.reasoning ?? "", /deterministic suspect paths are exhausted/);
});

test("RulePlanner reads the top ranked non-test exhausted search candidate", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/main.ts" } },
      ok: true,
      output: { path: "src/main.ts", content: "import { fetchUser } from \"./api.ts\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/main.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/api.ts" } },
      ok: true,
      output: { path: "src/api.ts", content: "export function other() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: "fetchUser" } },
      ok: true,
      output: {
        query: "fetchUser",
        results: [
          { file: "src/api.test.ts", line: 5, snippet: "expect(fetchUser).toBeDefined();" },
          { file: "src/services/user-api.ts", line: 9, snippet: "export default function fetchUser() {}" },
          { file: "node_modules/pkg/api.ts", line: 1, snippet: "fetchUser" },
        ],
        truncated: false,
        filesScanned: 6,
      },
      metadata: {
        category: "tool_observation",
        summary: "found fetchUser",
        retryable: false,
        toolName: "search_workspace",
      },
    },
  ], availableTools, "fix build failure", {
    step: 10,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "search_workspace",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      exhaustedSearchQuery: "fetchUser",
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "read_text_file",
    toolInput: { path: "src/services/user-api.ts" },
  });
  assert.match(decision.reasoning ?? "", /top ranked exhausted-repair search candidate/);
});

test("RulePlanner chooses deterministic import/export edit on searched candidate path", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/services/user-api.ts" } },
      ok: true,
      output: { path: "src/services/user-api.ts", content: "export default function fetchUser() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/services/user-api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 11,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 1,
      exhausted: true,
      exhaustedSearchQuery: "fetchUser",
      exhaustedSearchCandidatePaths: ["src/services/user-api.ts"],
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "patch_text_file",
    toolInput: {
      path: "src/services/user-api.ts",
      oldString: "export default function fetchUser() {}",
      newString: "export function fetchUser() {}",
    },
  });
  assert.match(decision.reasoning ?? "", /suspect path src\/services\/user-api\.ts/);
  assert.match(decision.reasoning ?? "", /import\/export style fix/);
});

test("RulePlanner fails only after direct and searched deterministic candidates are exhausted", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
    {
      name: "search_workspace",
      description: "Searches the workspace",
      inputSchema: { type: "object" },
    },
    {
      name: "patch_text_file",
      description: "Patches a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/main.ts" } },
      ok: true,
      output: { path: "src/main.ts", content: "import { fetchUser } from \"./api.ts\";\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/main.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/api.ts" } },
      ok: true,
      output: { path: "src/api.ts", content: "export function other() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
    {
      action: { kind: "tool_call", toolName: "search_workspace", toolInput: { query: "fetchUser" } },
      ok: true,
      output: {
        query: "fetchUser",
        results: [
          { file: "src/services/user-api.ts", line: 9, snippet: "export function other() {}" },
        ],
        truncated: false,
        filesScanned: 6,
      },
      metadata: {
        category: "tool_observation",
        summary: "found fetchUser",
        retryable: false,
        toolName: "search_workspace",
      },
    },
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/services/user-api.ts" } },
      ok: true,
      output: { path: "src/services/user-api.ts", content: "export function other() {}\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/services/user-api.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix build failure", {
    step: 12,
    phase: "investigate",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
    validationFailure: {
      mode: "build",
      failingCommands: ["build"],
      summary: "Validation build failed.",
      suspectFile: "src/main.ts",
      suspectImportPath: "./api.ts",
      suspectExportName: "fetchUser",
      suspectImportStyle: "named",
    },
    repairAttempt: {
      suspectFile: "src/main.ts",
      validationFailureCount: 2,
      editAttemptCount: 2,
      exhausted: true,
      lastStrategy: "synthesized import/export style fix",
      triedStrategies: ["synthesized import/export style fix"],
      triedSuspectPaths: ["src/main.ts", "src/api.ts"],
      triedStrategyPaths: ["synthesized import/export style fix@src/main.ts", "synthesized import/export style fix@src/api.ts"],
      exhaustedSearchQuery: "fetchUser",
      exhaustedSearchCandidatePaths: ["src/services/user-api.ts"],
      exhaustedReadCandidatePaths: ["src/services/user-api.ts"],
    },
  }));

  assert.equal(decision.action.kind, "fail");
  assert.match(decision.action.reason ?? "", /ranked search candidates/);
  assert.match(decision.action.reason ?? "", /exhaustedSearchQuery=fetchUser/);
  assert.match(decision.action.reason ?? "", /exhaustedSearchCandidatePaths=src\/services\/user-api\.ts/);
  assert.match(decision.action.reason ?? "", /exhaustedReadCandidatePaths=src\/services\/user-api\.ts/);
});

test("RulePlanner falls back to write_text_file from a recent read when patch_text_file is unavailable", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "write_text_file",
      description: "Writes a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "const value = 1;\n" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 2,
    phase: "edit",
    lastActionKind: "tool_call",
    lastToolName: "run_validation",
    validationFailure: {
      mode: "test",
      failingCommands: ["test"],
      summary: "Validation test failed.",
      suspectFile: "src/app.ts",
    },
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "write_text_file",
    toolInput: {
      path: "src/app.ts",
      content: "const value = 1;\n",
    },
  });
  assert.match(decision.reasoning ?? "", /patch_text_file unavailable/);
});

test("RulePlanner write_text_file fallback applies a validation-guided TS2322 rewrite", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "write_text_file",
      description: "Writes a file",
      inputSchema: { type: "object" },
    },
  ];
  const originalContent = "const value: number = \"123\";\n";

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: originalContent },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 2,
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
  }));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "write_text_file",
    toolInput: {
      path: "src/app.ts",
      content: "const value: number = 123;\n",
    },
  });
  const toolInput = decision.action.toolInput as { content: string };
  assert.notEqual(toolInput.content, originalContent);
  assert.match(decision.reasoning ?? "", /validation-guided full-file rewrite/);
});

test("RulePlanner synthesizes file/value answers after a read-only lookup", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "docs/secret.txt" } },
      ok: true,
      output: { path: "/tmp/workspace/docs/secret.txt", content: "Project codename: aurora\nSecret answer: 42\n" },
      metadata: {
        category: "tool_observation",
        summary: "read docs/secret.txt",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "find the secret answer in this workspace and tell me the file and value", {
    step: 2,
    phase: "summarize",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
  }));

  assert.equal(decision.action.kind, "respond");
  assert.match(decision.action.content ?? "", /docs\/secret\.txt/);
  assert.match(decision.action.content ?? "", /42/);
  assert.doesNotMatch(decision.action.content ?? "", /Preview:/);
  assert.match(decision.reasoning ?? "", /Phase summarize/);
});

test("RulePlanner summarizes after read-only inspection in summarize phase", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "read_text_file",
      description: "Reads a file",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
      ok: true,
      output: { path: "src/app.ts", content: "const value = 1;" },
      metadata: {
        category: "tool_observation",
        summary: "read src/app.ts",
        retryable: false,
        toolName: "read_text_file",
      },
    },
  ], availableTools, "fix validation error in src/app.ts", {
    step: 2,
    phase: "summarize",
    lastActionKind: "tool_call",
    lastToolName: "read_text_file",
  }));

  assert.equal(decision.action.kind, "respond");
  assert.match(decision.action.content ?? "", /已读取 src\/app\.ts/);
  assert.match(decision.reasoning ?? "", /Phase summarize/);
});

test("RulePlanner does not finish after a successful non-validation tool call", async () => {
  const planner = new RulePlanner();
  const availableTools: ToolDescriptor[] = [
    {
      name: "list_directory",
      description: "Lists files",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    {
      action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "src" } },
      ok: true,
      output: { entries: ["brain"] },
      metadata: {
        category: "tool_observation",
        summary: "listed src",
        retryable: false,
        toolName: "list_directory",
      },
    },
  ], availableTools, "inspect src", {
    step: 1,
    phase: "summarize",
    lastActionKind: "tool_call",
    lastToolName: "list_directory",
  }));

  assert.equal(decision.action.kind, "respond");
  assert.match(decision.action.content ?? "", /工具输出：/);
});


test("RulePlanner uses Chinese fallback text for generic responses", async () => {
  const planner = new RulePlanner();
  const decision = await planner.decide(makeInput([], [], "你好"));

  assert.equal(decision.action.kind, "respond");
  assert.match(decision.action.content ?? "", /我收到了你的消息/);
});

test("LlmPlanner auto-runs validation after a successful workspace mutation before consulting the model", async () => {
  const model = new RecordingModel({ kind: "respond", content: "should not be used" });
  const planner = new LlmPlanner(model);
  const availableTools: ToolDescriptor[] = [
    {
      name: "write_fixture",
      description: "Mutates a workspace file",
      inputSchema: { type: "object" },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
    },
    {
      name: "run_validation",
      description: "Runs validation scripts",
      inputSchema: { type: "object" },
    },
  ];

  const decision = await planner.decide(makeInput([
    makeWorkspaceMutationResult(),
  ], availableTools));

  assert.deepEqual(decision.action, {
    kind: "tool_call",
    toolName: "run_validation",
    toolInput: { mode: "all" },
  });
  assert.equal(model.calls, 0);
});

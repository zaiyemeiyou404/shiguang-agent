import { test } from "node:test";
import * as assert from "node:assert/strict";

import { runLoop } from "./loop.js";
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
    4,
  );

  assert.deepEqual(actions, ["patch_text_file", "run_validation", "respond"]);
  assert.equal(state.stopReason, "finish");
  assert.equal(state.workingMemory.phase, "summarize");
  assert.equal(state.history.length, 4);
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
        async decide(): Promise<BrainDecision> {
          return duplicateWrite;
        },
      },
      policy: {
        async check(next: BrainDecision): Promise<BrainDecision> {
          policyCalls += 1;
          assert.equal(next.action.kind, "finish");
          assert.notEqual(next.action.kind, "needs_approval");
          return next;
        },
      },
      dispatcher: {
        async dispatch(decision): Promise<ActionResult> {
          dispatcherCalls += 1;
          assert.equal(decision.action.kind, "finish");
          return {
            action: decision.action,
            ok: true,
            output: decision.action.content ?? "done",
            metadata: {
              category: "agent_finish",
              summary: "Duplicate mutation skipped.",
              retryable: false,
            },
          };
        },
      },
      evaluator: {
        async evaluate(decision) {
          assert.equal(decision.action.kind, "finish");
          return { kind: "stop", reason: "finish" } as const;
        },
      },
    },
    3,
  );

  assert.equal(policyCalls, 1);
  assert.equal(dispatcherCalls, 1);
  assert.equal(state.stopReason, "finish");
  assert.match(String(state.lastResult?.output), /Skipped duplicate write_text_file/);
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

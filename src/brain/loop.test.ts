import { test } from "node:test";
import * as assert from "node:assert/strict";

import { runLoop } from "./loop.js";
import type { BrainDecision, BrainInput, ActionResult } from "./types.js";
import type { ContextBundle, ContextItem } from "../context/types.js";

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

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { BasicEvaluator } from "./evaluator.js";
import type { BrainDecision, ActionResult } from "./types.js";

test("BasicEvaluator stops immediately after a respond action", async () => {
  const evaluator = new BasicEvaluator();
  const content = "你好！有什么可以帮你的吗？";
  const decision: BrainDecision = {
    action: { kind: "respond", content },
    reasoning: "Reply directly to the greeting.",
  };
  const result: ActionResult = {
    action: decision.action,
    ok: true,
    output: content,
    metadata: {
      category: "assistant_response",
      summary: content,
      retryable: false,
    },
  };

  const action = await evaluator.evaluate(decision, result, [result]);
  assert.deepEqual(action, { kind: "stop", reason: "respond" });
});

test("BasicEvaluator returns first non-retryable tool error to the planner", async () => {
  const evaluator = new BasicEvaluator();
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "missing.md" } },
    reasoning: "Read target file.",
  };
  const result: ActionResult = {
    action: decision.action,
    ok: false,
    output: null,
    error: "ENOENT: no such file or directory",
    metadata: {
      category: "tool_error",
      summary: "missing.md was not found",
      retryable: false,
      toolName: "read_text_file",
      errorKind: "not_found",
    },
  };

  const action = await evaluator.evaluate(decision, result, [result]);

  assert.deepEqual(action, { kind: "continue" });
});

test("BasicEvaluator pauses after repeated identical non-retryable tool errors", async () => {
  const evaluator = new BasicEvaluator();
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "missing.md" } },
    reasoning: "Read target file again.",
  };
  const history: ActionResult[] = [0, 1, 2].map(() => ({
    action: decision.action,
    ok: false,
    output: null,
    error: "ENOENT: no such file or directory",
    metadata: {
      category: "tool_error",
      summary: "missing.md was not found",
      retryable: false,
      toolName: "read_text_file",
      errorKind: "not_found",
    },
  }));

  const action = await evaluator.evaluate(decision, history[2]!, history);

  assert.equal(action.kind, "stop");
  assert.equal(action.reason, "non_retryable_tool_error");
});

test("BasicEvaluator pauses after repeated identical read-only tool calls", async () => {
  const evaluator = new BasicEvaluator();
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "src/app.ts" } },
    reasoning: "Read the file again.",
  };
  const history: ActionResult[] = [0, 1, 2].map(() => ({
    action: decision.action,
    ok: true,
    output: { path: "src/app.ts", content: "const ok = true;" },
    metadata: {
      category: "tool_observation",
      summary: "read src/app.ts",
      retryable: false,
      toolName: "read_text_file",
    },
  }));

  const action = await evaluator.evaluate(decision, history[2]!, history);

  assert.equal(action.kind, "stop");
  assert.equal(action.reason, "no_progress");
  assert.match(action.summary ?? "", /连续 3 次执行了相同/);
});

test("BasicEvaluator includes actionable recovery advice for repeated directory discovery", async () => {
  const evaluator = new BasicEvaluator();
  const decision: BrainDecision = {
    action: { kind: "tool_call", toolName: "list_directory", toolInput: { path: "." } },
    reasoning: "List again.",
  };
  const history: ActionResult[] = [0, 1, 2].map(() => ({
    action: decision.action,
    ok: true,
    output: { entries: [{ name: "README.md", kind: "file" }] },
    metadata: {
      category: "tool_observation",
      summary: "listed workspace root",
      retryable: false,
      toolName: "list_directory",
    },
  }));

  const action = await evaluator.evaluate(decision, history[2]!, history);

  assert.equal(action.kind, "stop");
  assert.equal(action.reason, "no_progress");
  assert.match(action.summary ?? "", /没有新增证据/);
  assert.match(action.summary ?? "", /read_text_file/);
  assert.match(action.summary ?? "", /search_workspace/);
});

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

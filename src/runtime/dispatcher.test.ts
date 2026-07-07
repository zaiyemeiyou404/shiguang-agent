import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ActionDispatcher } from "./dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryEventSink } from "./event-sink.js";

test("ActionDispatcher emits approval_request for needs_approval actions", async () => {
  const sink = new InMemoryEventSink();
  const dispatcher = new ActionDispatcher(new ToolRegistry(), sink);

  const result = await dispatcher.dispatch({
    action: {
      kind: "needs_approval",
      toolName: "write_text_file",
      toolInput: { path: "a.ts", content: "x" },
      capability: "fs.write",
      approvalId: "appr_write",
      reason: "Approval required",
    },
    reasoning: "blocked by policy",
  }, "run_1");

  assert.equal(result.ok, false);
  assert.equal(result.metadata?.errorKind, "permission_denied");
  const events = await sink.list("run_1");
  assert.equal(events.some((event) => event.kind === "approval_request"), true);
  const approvalEvent = events.find((event) => event.kind === "approval_request");
  assert.equal(typeof approvalEvent?.payload, "object");
  assert.equal((approvalEvent?.payload as { capability?: string }).capability, "fs.write");
});

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ActionDispatcher } from "./dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryEventSink } from "./event-sink.js";
import type { Tool } from "../tools/types.js";

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

test("ActionDispatcher attaches tool approval previews", async () => {
  const sink = new InMemoryEventSink();
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      name: "preview_tool",
      description: "Tool with approval preview",
      inputSchema: {},
      requiresApproval: true,
      capability: "preview.write",
    },
    previewApproval() {
      return {
        kind: "summary",
        title: "Preview title",
      };
    },
    async execute() {
      return { ok: true };
    },
  });
  const dispatcher = new ActionDispatcher(registry, sink);

  await dispatcher.dispatch({
    action: {
      kind: "needs_approval",
      toolName: "preview_tool",
      toolInput: { value: 1 },
      capability: "preview.write",
      approvalId: "appr_preview",
      reason: "Approval required",
    },
    reasoning: "blocked by policy",
  }, "run_preview");

  const events = await sink.list("run_preview");
  const approvalEvent = events.find((event) => event.kind === "approval_request");
  const payload = approvalEvent?.payload as { request?: { preview?: { title?: string } } } | undefined;
  assert.equal(payload?.request?.preview?.title, "Preview title");
});

test("ActionDispatcher tags tool_call and tool_result with the same toolCallId", async () => {
  const sink = new InMemoryEventSink();
  const registry = new ToolRegistry();
  const echoTool: Tool = {
    descriptor: {
      name: "test_echo",
      description: "Echo test tool",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    },
    async execute(input) {
      return { echoed: input };
    },
  };
  registry.register(echoTool);
  const dispatcher = new ActionDispatcher(registry, sink);

  const result = await dispatcher.dispatch({
    action: {
      kind: "tool_call",
      toolName: "test_echo",
      toolInput: { value: "hello" },
    },
    reasoning: "run test echo",
  }, "run_2");

  assert.equal(result.ok, true);
  assert.equal(typeof result.metadata?.toolCallId, "string");
  const events = await sink.list("run_2");
  const toolCallEvent = events.find((event) => event.kind === "tool_call");
  const toolResultEvent = events.find((event) => event.kind === "tool_result");
  assert.ok(toolCallEvent);
  assert.ok(toolResultEvent);
  const toolCallId = (toolCallEvent?.payload as { toolCallId?: unknown }).toolCallId;
  const toolResultId = (toolResultEvent?.payload as { toolCallId?: unknown }).toolCallId;
  assert.equal(typeof toolCallId, "string");
  assert.equal(toolResultId, toolCallId);
  assert.equal(result.metadata?.toolCallId, toolCallId);
});

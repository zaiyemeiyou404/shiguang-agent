import { test } from "node:test";
import * as assert from "node:assert/strict";

import { LlmPlanner, RulePlanner } from "./planner.js";
import type { BrainInput, ActionResult, BrainDecision } from "./types.js";
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

function makeInput(history: ActionResult[], availableTools: ToolDescriptor[]): BrainInput {
  return {
    context: makeContext("please update the file"),
    runId: "run_1",
    priorTurns: [],
    history,
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

  assert.equal(decision.action.kind, "finish");
  assert.match(decision.action.content ?? "", /Tool output:/);
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

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { Agent } from "./agent.js";
import type { BrainDecision } from "../brain/types.js";
import type { Planner } from "../brain/planner.js";
import { InMemoryEventSink } from "../runtime/event-sink.js";
import type { Tool } from "../tools/types.js";

test("Agent auto-continues after a step budget slice before returning final feedback", async () => {
  let decisions = 0;
  const planner: Planner = {
    async decide(): Promise<BrainDecision> {
      decisions++;
      if (decisions <= 72) {
        return {
          action: { kind: "tool_call", toolName: "echo", toolInput: `step ${decisions}` },
          reasoning: "Keep working until the first slice is exhausted.",
        };
      }

      return {
        action: { kind: "respond", content: "完整结果：已经跨过步数分片并自动续跑。" },
        reasoning: "The continuation checkpoint is ready for final feedback.",
      };
    },
  };

  const sink = new InMemoryEventSink();
  const agent = new Agent({ eventSink: sink, planner });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const output = await agent.run({
    runId: "run_auto_continue",
    userMessage: "run until final",
    contextInput: {
      task: {
        id: "task_auto_continue",
        sessionId: "sess_auto_continue",
        parentTaskId: null,
        title: "Auto continue",
        description: null,
        status: "in_progress",
        priority: 0,
        createdAt: now,
        updatedAt: now,
      },
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
    },
  });

  assert.equal(output.state.stopReason, "respond");
  assert.equal(output.state.steps, 73);
  assert.match(String(output.state.lastResult?.output), /完整结果/);

  const events = await sink.list("run_auto_continue");
  assert.equal(events.some((event) => {
    const payload = event.payload as { autoContinuation?: boolean };
    return event.kind === "system" && payload.autoContinuation === true;
  }), true);
});

test("Agent caps automatic continuations to avoid runaway model spend", async () => {
  let decisions = 0;
  const planner: Planner = {
    async decide(): Promise<BrainDecision> {
      decisions++;
      return {
        action: { kind: "tool_call", toolName: "echo", toolInput: `loop ${decisions}` },
        reasoning: "Keep looping so the cost guard has to stop the run.",
      };
    },
  };

  const sink = new InMemoryEventSink();
  const agent = new Agent({ eventSink: sink, planner });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const output = await agent.run({
    runId: "run_auto_continue_guard",
    userMessage: "loop forever",
    contextInput: {
      task: {
        id: "task_auto_continue_guard",
        sessionId: "sess_auto_continue_guard",
        parentTaskId: null,
        title: "Auto continue guard",
        description: null,
        status: "in_progress",
        priority: 0,
        createdAt: now,
        updatedAt: now,
      },
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
    },
  });

  assert.equal(output.state.stopReason, "step_limit");
  assert.equal(output.state.steps, 144);
  assert.match(output.state.stopSummary ?? "", /避免继续消耗模型 token/);

  const events = await sink.list("run_auto_continue_guard");
  const continuations = events.filter((event) => {
    const payload = event.payload as { autoContinuation?: boolean };
    return event.kind === "system" && payload.autoContinuation === true;
  });
  assert.equal(continuations.length, 1);
});

test("Agent profile allowlist limits the planner-visible tool registry", async () => {
  const seenToolNames: string[][] = [];
  const planner: Planner = {
    async decide(input): Promise<BrainDecision> {
      seenToolNames.push(input.availableTools.map((tool) => tool.name));
      return {
        action: { kind: "respond", content: "profile applied" },
        reasoning: "Verified profile tool allowlist.",
      };
    },
  };

  const sink = new InMemoryEventSink();
  const agent = new Agent({
    eventSink: sink,
    planner,
    tools: [testTool("allowed_tool"), testTool("blocked_tool")],
    agentProfile: {
      name: "safe",
      tools: ["allowed_tool"],
      sourcePath: ".shiguang/agents/safe.md",
      instructions: "Use only the allowed tool.",
    },
  });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const output = await agent.run({
    runId: "run_profile_allowlist",
    userMessage: "check profile",
    contextInput: {
      task: {
        id: "task_profile_allowlist",
        sessionId: "sess_profile_allowlist",
        parentTaskId: null,
        title: "Profile allowlist",
        description: null,
        status: "in_progress",
        priority: 0,
        createdAt: now,
        updatedAt: now,
      },
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
    },
  });

  assert.equal(output.state.stopReason, "respond");
  assert.deepEqual(seenToolNames[0], ["allowed_tool"]);
});

function testTool(name: string): Tool {
  return {
    descriptor: {
      name,
      description: `${name} test tool`,
      inputSchema: {},
    },
    async execute() {
      return `${name} executed`;
    },
  };
}

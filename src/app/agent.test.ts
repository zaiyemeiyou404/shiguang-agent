import { test } from "node:test";
import * as assert from "node:assert/strict";

import { Agent } from "./agent.js";
import type { BrainDecision } from "../brain/types.js";
import type { Planner } from "../brain/planner.js";
import { InMemoryEventSink } from "../runtime/event-sink.js";

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

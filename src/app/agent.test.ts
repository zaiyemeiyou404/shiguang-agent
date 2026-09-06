import { test } from "node:test";
import * as assert from "node:assert/strict";

import { Agent } from "./agent.js";
import type { BrainDecision } from "../brain/types.js";
import type { Planner } from "../brain/planner.js";
import { InMemoryEventSink } from "../runtime/event-sink.js";
import type { Tool } from "../tools/types.js";
import type { Turn } from "../core/types.js";
import type { TurnRepository } from "../state/repositories.js";
import type { CustomSkill } from "../tools/builtins/custom-extensions.js";

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
  assert.equal(output.state.steps, 360);
  assert.match(output.state.stopSummary ?? "", /避免继续消耗模型 token/);

  const events = await sink.list("run_auto_continue_guard");
  const continuations = events.filter((event) => {
    const payload = event.payload as { autoContinuation?: boolean };
    return event.kind === "system" && payload.autoContinuation === true;
  });
  assert.equal(continuations.length, 4);
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

test("Agent injects custom skills into prompts without persisting them as visible system turns", async () => {
  let sawSkillPrompt = false;
  const planner: Planner = {
    async decide(input): Promise<BrainDecision> {
      sawSkillPrompt = input.context.stable.some((item) => {
        return item.kind === "system_instruction"
          && item.content.includes("Relevant Shiguang skills are active")
          && item.content.includes("Skill: web_article_reader");
      });
      return {
        action: { kind: "respond", content: "skill prompt applied" },
        reasoning: "Verified custom skill prompt injection.",
      };
    },
  };

  const turns = new InMemoryTurnRepository();
  const sink = new InMemoryEventSink();
  const agent = new Agent({
    eventSink: sink,
    planner,
    turnRepository: turns,
    customSkills: [testSkill("web_article_reader", "When a URL is provided, fetch the page before answering.")],
  });
  const now = new Date("2026-01-01T00:00:00.000Z");

  await agent.run({
    runId: "run_skill_prompt_visibility",
    userMessage: "看一下 https://example.test/article",
    contextInput: {
      task: {
        id: "task_skill_prompt_visibility",
        sessionId: "sess_skill_prompt_visibility",
        parentTaskId: null,
        title: "Skill prompt visibility",
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

  assert.equal(sawSkillPrompt, true);
  const persistedTurns = await turns.listBySession("sess_skill_prompt_visibility");
  assert.deepEqual(persistedTurns.map((turn) => turn.role), ["user", "assistant"]);
  assert.equal(persistedTurns.some((turn) => turn.content.includes("Relevant Shiguang skills are active")), false);
});

test("Agent emits task-loop progress events for the desktop run readout", async () => {
  const planner: Planner = {
    async decide(): Promise<BrainDecision> {
      return {
        action: { kind: "tool_call", toolName: "read_text_file", toolInput: { path: "README.md" } },
        reasoning: "Read the requested file before answering.",
      };
    },
  };

  const sink = new InMemoryEventSink();
  const agent = new Agent({
    eventSink: sink,
    planner,
    tools: [testTool("read_text_file")],
  });
  const now = new Date("2026-01-01T00:00:00.000Z");
  const output = await agent.run({
    runId: "run_task_loop_events",
    userMessage: "analyze README.md",
    contextInput: {
      task: {
        id: "task_task_loop_events",
        sessionId: "sess_task_loop_events",
        parentTaskId: null,
        title: "Task loop events",
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

  assert.equal(output.state.workingMemory.taskLoop?.currentStep, "answer");
  const events = await sink.list("run_task_loop_events");
  const taskLoopEvents = events.filter((event) => {
    const payload = event.payload as { phase?: unknown };
    return event.kind === "tool_pipeline" && payload.phase === "task_loop";
  });
  assert.equal(taskLoopEvents.length >= 2, true);
  assert.equal((taskLoopEvents[0]?.payload as { status?: unknown }).status, "initialized");
  assert.equal((taskLoopEvents.at(-1)?.payload as { currentStep?: unknown }).currentStep, "answer");
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

function testSkill(name: string, instructions: string): CustomSkill {
  return {
    name,
    enabled: true,
    path: `.shiguang/skills/${name}.md`,
    instructions,
    contract: "shiguang.skill.v1",
    layer: "global",
    triggers: ["https://", "网页", "文章"],
    priority: 50,
    version: 1,
  };
}

class InMemoryTurnRepository implements TurnRepository {
  private turns: Turn[] = [];

  async create(turn: Turn): Promise<void> {
    this.turns.push(turn);
  }

  async listBySession(sessionId: string, limit?: number): Promise<Turn[]> {
    const matched = this.turns.filter((turn) => turn.sessionId === sessionId);
    return typeof limit === "number" ? matched.slice(-limit) : matched;
  }
}

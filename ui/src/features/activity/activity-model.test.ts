import { describe, expect, it } from "vitest";

import type { DesktopConversationEntry, DesktopEvent, DesktopEventPayload } from "../../bridge";
import { buildActivityItems, campusCardUrl, mergeDesktopEvents } from "./activity-model";

function event(id: string, seq: number, kind: DesktopEvent["kind"], payload: unknown): DesktopEvent {
  return { id, runId: "run-1", seq, kind, payload: payload as DesktopEventPayload, createdAt: `2026-09-17T00:00:0${seq}.000Z` };
}

describe("mergeDesktopEvents", () => {
  it("deduplicates event ids and orders by sequence", () => {
    const first = event("evt-1", 1, "thinking", { content: "分析" });
    const replacement = { ...first, payload: { content: "更新后的分析" } };
    const second = event("evt-2", 2, "message", { role: "assistant", content: "完成" });

    expect(mergeDesktopEvents([second, first], [replacement])).toEqual([replacement, second]);
  });
});

describe("buildActivityItems", () => {
  it("keeps historical turns and suppresses the persisted copy of a live message", () => {
    const conversation: DesktopConversationEntry[] = [{
      id: "event:evt-2",
      sessionId: "session-1",
      runId: "run-1",
      source: "event",
      kind: "message",
      role: "assistant",
      from: "拾光 Agent",
      content: "完成",
      createdAt: "2026-09-17T00:00:02.000Z",
    }];

    expect(buildActivityItems(conversation, [event("evt-2", 2, "message", { role: "assistant", content: "完成" })]))
      .toMatchObject([{ type: "response", id: "event:evt-2", content: "完成" }]);
  });

  it("suppresses a live assistant event when its persisted assistant turn is already shown", () => {
    const conversation: DesktopConversationEntry[] = [{
      id: "turn:assistant-1",
      sessionId: "session-1",
      runId: null,
      source: "turn",
      kind: "message",
      role: "assistant",
      from: "拾光 Agent",
      content: "完成",
      createdAt: "2026-09-17T00:00:02.100Z",
    }];

    const items = buildActivityItems(conversation, [event("evt-2", 2, "message", { role: "assistant", content: "完成" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "turn:assistant-1", type: "response", content: "完成" });
  });

  it("keeps a later run's reply when it repeats an earlier answer", () => {
    const conversation: DesktopConversationEntry[] = [{
      id: "turn:assistant-1",
      sessionId: "session-1",
      runId: "run-1",
      source: "turn",
      kind: "message",
      role: "assistant",
      from: "拾光 Agent",
      content: "完成",
      createdAt: "2026-09-17T00:00:02.000Z",
    }];
    const later = { ...event("evt-9", 9, "message", { role: "assistant", content: "完成" }), runId: "run-2", createdAt: "2026-09-17T00:00:09.000Z" };

    const items = buildActivityItems(conversation, [later]).filter((item) => item.type === "response");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual(["turn:assistant-1", "event:evt-9"]);
  });

  it("does not render persisted internal instructions as conversation cards", () => {
    const conversation: DesktopConversationEntry[] = [{
      id: "turn:system-1",
      sessionId: "session-1",
      runId: null,
      source: "turn",
      kind: "system",
      role: "system",
      from: "系统",
      content: "User attached local files for this run.\nUse read/search/stat tools against these paths when relevant:",
      createdAt: "2026-09-17T00:00:02.000Z",
    }];

    expect(buildActivityItems(conversation, [])).toEqual([]);
  });

  it("creates response, thinking, system, error, approval, and context items", () => {
    const items = buildActivityItems([], [
      event("message", 1, "message", { role: "assistant", content: "结果" }),
      event("thinking", 2, "thinking", { content: "推理" }),
      event("system", 3, "system", { message: "已连接" }),
      event("error", 4, "error", { message: "失败", code: "E_FAIL" }),
      event("approval", 5, "approval_request", { approvalId: "approval-1", capability: "terminal" }),
      event("context", 6, "context_compacted", { message: "已压缩", originalBudget: 1000, finalBudget: 600 }),
    ]);

    expect(items.map((item) => item.type)).toEqual(["response", "thinking", "system", "error", "approval", "context"]);
  });

  it("pairs tool calls and results by toolCallId while preserving orphans", () => {
    const items = buildActivityItems([], [
      event("result-first", 1, "tool_result", { toolCallId: "call-1", tool: "read_text_file", output: "ok" }),
      event("call", 2, "tool_call", { toolCallId: "call-1", tool: "read_text_file", arguments: { path: "a.ts" } }),
      event("orphan", 3, "tool_result", { toolCallId: "missing", tool: "search", output: "none" }),
    ]).filter((item) => item.type === "tool");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "tool", toolCallId: "call-1", tool: "read_text_file", status: "success" });
    expect(items[1]).toMatchObject({ type: "tool", toolCallId: "missing", tool: "search", status: "orphan-result" });
  });

  it("falls back safely for malformed legacy payloads", () => {
    const items = buildActivityItems([], [event("legacy", 1, "error", "legacy failure")]);
    expect(items[0]).toMatchObject({ type: "error", message: "legacy failure" });
  });

  it("groups repeated thinking events into one work-process item", () => {
    const items = buildActivityItems([], [
      event("thinking-1", 1, "thinking", { reasoning: "检查入口" }),
      event("thinking-2", 2, "thinking", { content: "读取配置" }),
      event("thinking-3", 3, "thinking", { content: "读取配置" }),
    ]).filter((item) => item.type === "thinking");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ steps: ["检查入口", "读取配置"] });
  });

  it("deduplicates repeated persisted responses from the same run", () => {
    const repeated: DesktopConversationEntry[] = ["turn-1", "turn-2"].map((id) => ({
      id,
      sessionId: "session-1",
      runId: "run-1",
      source: "turn",
      kind: "message",
      role: "user",
      from: "你",
      content: "你好",
      createdAt: "2026-09-17T00:00:01.000Z",
    }));

    expect(buildActivityItems(repeated, []).filter((item) => item.type === "response")).toHaveLength(1);
  });

  it("shows repeated answers when persisted turns are not tied to a run", () => {
    const repeated: DesktopConversationEntry[] = ["turn-1", "turn-2"].map((id, index) => ({
      id,
      sessionId: "session-1",
      runId: null,
      source: "turn",
      kind: "message",
      role: "assistant",
      from: "拾光 Agent",
      content: "完成",
      createdAt: `2026-09-17T00:00:0${index + 1}.000Z`,
    }));

    const items = buildActivityItems(repeated, []);
    expect(items.filter((item) => item.type === "response")).toHaveLength(2);
  });
});

describe("campusCardUrl", () => {
  it("accepts only a local campus card link", () => {
    expect(campusCardUrl({ cardUrl: "http://127.0.0.1:47321/c/abc123abc123" })).toBe("http://127.0.0.1:47321/c/abc123abc123");
    expect(campusCardUrl({ cardUrl: "https://example.com/c/abc123abc123" })).toBeNull();
    expect(campusCardUrl("http://127.0.0.1:47321/c/abc123abc123")).toBeNull();
  });
});

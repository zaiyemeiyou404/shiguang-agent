import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DesktopEvent } from "../../bridge";
import { ActivityFeed } from "./ActivityFeed";

function event(id: string, seq: number, kind: DesktopEvent["kind"], payload: DesktopEvent["payload"]): DesktopEvent {
  return { id, runId: "run-1", seq, kind, payload, createdAt: `2026-09-17T00:00:0${seq}.000Z` };
}

describe("ActivityFeed", () => {
  it("renders response, thinking and paired tool activity", () => {
    render(<ActivityFeed entries={[]} events={[
      event("m", 1, "message", { role: "assistant", content: "完成" }),
      event("t", 2, "thinking", { content: "检查代码" }),
      event("c", 3, "tool_call", { tool: "read_text_file", toolCallId: "call-1", input: { path: "a.ts" }, arguments: { path: "a.ts" } }),
      event("r", 4, "tool_result", { tool: "read_text_file", toolCallId: "call-1", output: "ok", isError: false }),
    ]} />);
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(screen.getByText(/^工作过程/)).toBeInTheDocument();
    expect(screen.getByText("read_text_file")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  it("expands a campus card on the right of the conversation", () => {
    const cardUrl = "http://127.0.0.1:47321/c/abc123abc123";
    render(<ActivityFeed entries={[]} events={[
      event("c", 1, "tool_call", { tool: "xdyou_schedule", toolCallId: "call-1", input: { query: "这周课表" }, arguments: { query: "这周课表" } }),
      event("r", 2, "tool_result", { tool: "xdyou_schedule", toolCallId: "call-1", output: { cardUrl }, isError: false }),
    ]} />);
    const frame = screen.getByTitle("校园卡片");
    expect(frame).toHaveAttribute("src", cardUrl);
    expect(frame.closest(".campus-card-pane")).not.toBeNull();
    expect(frame.closest(".process-tool")).toBeNull();
    expect(screen.getByText("卡片已在右侧展开。")).toBeInTheDocument();
  });
});

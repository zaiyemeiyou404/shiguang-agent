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
});

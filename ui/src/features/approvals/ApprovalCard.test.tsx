import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DesktopApproval } from "../../bridge";
import { ApprovalCard } from "./ApprovalCard";

const approval: DesktopApproval = {
  id: "approval-1", runId: "run-1", pluginId: "builtin", capability: "terminal.execute", status: "pending", decidedAt: null,
  request: { toolName: "run_terminal_command", toolInput: { command: "npm test", cwd: "G:\\repo" }, reason: "执行测试", preview: null },
};

describe("ApprovalCard", () => {
  it("shows risk context and submits a single explicit decision", async () => {
    const decide = vi.fn();
    const user = userEvent.setup();
    render(<ApprovalCard approval={approval} onDecision={decide} />);
    expect(screen.getByText("terminal.execute")).toBeInTheDocument();
    expect(screen.getByText("G:\\repo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "允许一次" }));
    expect(decide).toHaveBeenCalledWith("approval-1", "granted");
  });

  it("disables both decisions while a request is in flight", () => {
    render(<ApprovalCard approval={approval} decisionState="approving" onDecision={() => {}} />);
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
  });
});

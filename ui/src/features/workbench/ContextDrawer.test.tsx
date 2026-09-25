import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalPanel } from "./ApprovalPanel";
import { ContextDrawer } from "./ContextDrawer";

describe("ContextDrawer", () => {
  it("keeps a pending approval actionable after opening the approval drawer tab", async () => {
    const user = userEvent.setup();
    const decideApproval = vi.fn();
    render(<Harness onDecision={decideApproval} />);

    await user.click(screen.getByRole("tab", { name: "审批" }));
    expect(screen.getByText("等待审批")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "允许一次" }));
    expect(decideApproval).toHaveBeenCalledWith("approval-1", "granted", "once");
  });
});

function Harness({ onDecision }: { onDecision: (approvalId: string, decision: "granted" | "denied", scope: "once") => void }) {
  const [activeTab, setActiveTab] = useState("任务");
  return <ContextDrawer
    activeTab={activeTab}
    onTabChange={setActiveTab}
    panels={{
      "任务": <div>任务内容</div>,
      "审批": <ApprovalPanel approvals={[{ id: "approval-1", title: "等待审批" }]} onDecision={onDecision} />,
      "工具": <div>工具内容</div>,
      "产物": <div>产物内容</div>,
    }}
  />;
}

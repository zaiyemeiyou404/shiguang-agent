import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConversationPane } from "./ConversationPane";
import { TaskPanel } from "./TaskPanel";
import { WorkbenchShell } from "./WorkbenchShell";

describe("WorkbenchShell", () => {
  it("closes the context drawer with Escape and restores focus to its opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "任务详情" });
    await user.click(opener);
    expect(screen.getByRole("complementary", { name: "上下文面板" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "上下文面板" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("shows task progress in one compact line and opens complete details on demand", async () => {
    const user = userEvent.setup();
    render(<TaskHarness />);

    expect(screen.getByText("正在重构前端")).toBeVisible();
    expect(screen.getByText("进行中 · 3 / 6")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "任务详情" }));
    expect(screen.getByRole("heading", { name: "任务" })).toBeVisible();
    expect(screen.getByText("本次证据")).toBeVisible();
  });
});

function Harness() {
  return <WorkbenchShell sidebar={<div>侧栏</div>} header={<div>顶部</div>} statusBar={null} conversation={<div>对话</div>} drawer={<div>任务内容</div>} />;
}

function TaskHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <ConversationPane
      title="聊天"
      taskTitle="正在重构前端"
      progressLabel="进行中 · 3 / 6"
      onOpenTaskDrawer={() => setOpen(true)}
    >
      <div>对话时间线</div>
    </ConversationPane>
    {open ? <TaskPanel heading="任务" evidence="本次证据" steps={[]} /> : null}
  </>;
}

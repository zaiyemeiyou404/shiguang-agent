import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

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
});

function Harness() {
  return <WorkbenchShell sidebar={<div>侧栏</div>} header={<div>顶部</div>} statusBar={null} conversation={<div>对话</div>} drawer={<div>任务内容</div>} />;
}

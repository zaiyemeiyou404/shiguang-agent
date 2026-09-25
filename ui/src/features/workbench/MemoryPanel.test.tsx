import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "./MemoryPanel";

describe("MemoryPanel", () => {
  it("shows stale memories only under the stale filter and keeps delete available", async () => {
    const user = userEvent.setup();
    const onForget = vi.fn();
    render(<MemoryPanel candidates={[]} memories={[
      { id: "active", summary: "活跃记忆", status: "active" },
      { id: "stale", summary: "过期记忆", status: "stale" },
    ]} onAccept={vi.fn()} onDismiss={vi.fn()} onMarkStale={vi.fn()} onForget={onForget} />);

    expect(screen.queryByText("过期记忆")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "已失效 1" }));
    expect(screen.getByText("过期记忆")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(onForget).toHaveBeenCalledWith("stale");
  });
});

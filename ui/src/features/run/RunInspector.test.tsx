import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DesktopArtifact, DesktopRun } from "../../bridge";
import { RunInspector } from "./RunInspector";

const run: DesktopRun = { id: "run-123456789", sessionId: "session-1", status: "failed", reason: "test failed", startedAt: "2026-09-17T00:00:00Z", endedAt: "2026-09-17T00:00:01Z", summary: null };
const artifact: DesktopArtifact = { id: "artifact-1", sessionId: "session-1", taskId: null, runId: run.id, kind: "summary", uri: "G:\\repo\\out.txt", title: "结果", metadata: {}, createdAt: "2026-09-17T00:00:01Z" };

describe("RunInspector", () => {
  it("shows run recovery and artifact actions", async () => {
    const retry = vi.fn();
    const reveal = vi.fn();
    const user = userEvent.setup();
    render(<RunInspector open onClose={() => {}} activeRun={run} runs={[run]} events={[]} approvals={[]} artifacts={[artifact]} failure={{ title: "测试失败", summary: "构建未通过", cause: "断言失败", nextStep: "修复断言" }} onSelectRun={() => {}} onRetry={retry} onBranch={() => {}} onDraftRepair={() => {}} onCopyArtifact={() => {}} onOpenArtifact={() => {}} onRevealArtifact={reveal} />);
    expect(screen.getByRole("complementary", { name: "运行检查器" })).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
    const retryButtons = screen.getAllByRole("button", { name: "重新运行" });
    await user.click(retryButtons[0]!);
    await user.click(screen.getByRole("button", { name: "定位" }));
    expect(retry).toHaveBeenCalledWith(run.id);
    expect(reveal).toHaveBeenCalledWith(artifact.uri);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopEvent, DesktopSessionDetail, DesktopWorkspaceSnapshot, ShiguangBridge } from "./bridge";
import WorkbenchApp from "./WorkbenchApp";

const now = "2026-09-25T12:00:00.000Z";

function event(id: string, seq: number, kind: DesktopEvent["kind"], payload: DesktopEvent["payload"]): DesktopEvent {
  return { id, runId: "run-1", seq, kind, payload, createdAt: now };
}

function createBridge() {
  const detail: DesktopSessionDetail = {
    session: { id: "session-1", workspaceId: "workspace-1", title: "检查前端", status: "active", createdAt: now, updatedAt: now, summary: null },
    runs: [{ id: "run-1", sessionId: "session-1", status: "completed", reason: null, startedAt: now, endedAt: now, summary: "检查完成" }],
    turns: [],
    conversation: [
      { id: "turn-user", sessionId: "session-1", runId: "run-1", source: "turn", kind: "message", role: "user", from: "你", content: "看看前端", createdAt: now },
      { id: "turn-answer", sessionId: "session-1", runId: "run-1", source: "turn", kind: "message", role: "assistant", from: "拾光 Agent", content: "已经检查完成。", createdAt: now },
    ],
    tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, requests: 1, latestTotalTokens: 20 },
  };
  const snapshot: DesktopWorkspaceSnapshot = {
    detail,
    pendingApprovals: [{
      id: "approval-1", runId: "run-1", pluginId: "builtin", capability: "fs.write", status: "granted", decidedAt: now,
      request: { toolName: "write_text_file", toolInput: { path: "src/App.tsx" }, reason: "需要修改文件", preview: null },
    }],
    artifacts: [],
  };
  const events: DesktopEvent[] = [
    event("think-1", 1, "thinking", { content: "检查入口" }),
    event("think-2", 2, "thinking", { reasoning: "核对组件" }),
    event("call-1", 3, "tool_call", { tool: "read_text_file", toolCallId: "tool-1", input: { path: "src/App.tsx" }, arguments: { path: "src/App.tsx" } }),
    event("result-1", 4, "tool_result", { tool: "read_text_file", toolCallId: "tool-1", output: "ok", isError: false }),
    event("answer-1", 5, "message", { role: "assistant", content: "已经检查完成。" }),
    event("approval-event", 6, "approval_request", { approvalId: "approval-1", pluginId: "builtin", capability: "fs.write", request: snapshot.pendingApprovals[0]!.request }),
  ];

  const bridge = {
    listProjects: vi.fn().mockResolvedValue([{ id: "project-1", name: "拾光", createdAt: now, updatedAt: now }]),
    createProject: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([{ id: "workspace-1", projectId: "project-1", name: "主工作区", rootPath: "G:/projects/shiguang", available: true, createdAt: now, updatedAt: now }]),
    createWorkspace: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([detail.session]),
    getSettings: vi.fn().mockResolvedValue({ configPath: "config.json", workspaceRoot: "G:/projects/shiguang", toolApprovalMode: "ask", executionPreset: "workspace_write_network", llm: { provider: "deepseek", model: "deepseek-chat" }, providers: { deepseek: { model: "deepseek-chat" } }, mcpServers: {} }),
    saveSettings: vi.fn(),
    testProviderConnection: vi.fn(),
    createSession: vi.fn(),
    branchSession: vi.fn(),
    renameSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    updateSessionWorkspace: vi.fn(),
    updateSessionLlm: vi.fn(),
    deleteSession: vi.fn(),
    getSessionDetail: vi.fn().mockResolvedValue(detail),
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(snapshot),
    listArtifacts: vi.fn().mockResolvedValue([]),
    openArtifact: vi.fn(),
    revealArtifact: vi.fn(),
    pickAttachments: vi.fn().mockResolvedValue([]),
    sendUserMessage: vi.fn().mockResolvedValue({ ...detail.runs[0], id: "run-2", status: "pending" }),
    getRunEvents: vi.fn().mockResolvedValue(events),
    listPendingApprovals: vi.fn().mockResolvedValue(snapshot.pendingApprovals),
    listReusableApprovals: vi.fn().mockResolvedValue([]),
    revokeApprovalScope: vi.fn(),
    listWorkspaceMemories: vi.fn().mockResolvedValue([]),
    forgetWorkspaceMemory: vi.fn(),
    markWorkspaceMemoryStale: vi.fn(),
    listMemoryCandidates: vi.fn().mockResolvedValue([]),
    acceptMemoryCandidate: vi.fn(),
    dismissMemoryCandidate: vi.fn(),
    decideApproval: vi.fn(),
    cancelRun: vi.fn(),
    pauseRun: vi.fn(),
    retryRun: vi.fn(),
    subscribeRunEvents: vi.fn().mockReturnValue(() => {}),
  };
  return bridge as unknown as ShiguangBridge & { sendUserMessage: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  delete (window as Window & { shiguang?: ShiguangBridge }).shiguang;
  localStorage.clear();
});

describe("WorkbenchApp", () => {
  it("keeps the selected workspace, merges activity, and sends through the active session", async () => {
    const bridge = createBridge();
    (window as Window & { shiguang?: ShiguangBridge }).shiguang = bridge;
    const user = userEvent.setup();
    render(<WorkbenchApp />);

    expect((await screen.findAllByText("主工作区")).length).toBeGreaterThan(0);
    expect(await screen.findByText("工作过程 · 2 步")).toBeInTheDocument();
    expect(screen.getAllByText("已经检查完成。")).toHaveLength(1);
    expect(screen.getByText("read_text_file")).toBeInTheDocument();
    expect(screen.getByText("操作确认")).toBeInTheDocument();

    const composer = screen.getByPlaceholderText("输入任务、问题或命令…");
    await user.type(composer, "继续检查");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(bridge.sendUserMessage).toHaveBeenCalledWith({ sessionId: "session-1", message: "继续检查", attachments: [] }));
  });
});

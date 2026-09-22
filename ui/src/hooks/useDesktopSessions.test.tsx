import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopProject, DesktopSession, DesktopWorkspace, ShiguangBridge } from "../bridge";
import { useDesktopSessions } from "./useDesktopSessions";

const defaultProject: DesktopProject = {
  id: "project-1", name: "默认项目", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
};

const workspaces: DesktopWorkspace[] = [
  { id: "workspace-empty", projectId: defaultProject.id, name: "工作区", rootPath: "G:\\empty", available: true, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" },
  { id: "workspace-default", projectId: defaultProject.id, name: "默认工作区", rootPath: "G:\\default", available: true, createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" },
];

const sessions: DesktopSession[] = [
  { id: "session-default", workspaceId: "workspace-default", title: "已有会话", status: "active", createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", summary: null },
];

afterEach(() => {
  delete window.shiguang;
  localStorage.clear();
});

describe("useDesktopSessions", () => {
  it("keeps an explicitly selected empty workspace active instead of switching to another workspace session", async () => {
    localStorage.setItem("shiguang.activeWorkspaceId", "workspace-empty");
    window.shiguang = {
      listSessions: async () => sessions,
      listProjects: async () => [defaultProject],
      listWorkspaces: async () => workspaces,
      getWorkspaceSnapshot: async (sessionId) => ({
        detail: { session: sessions.find((session) => session.id === sessionId)!, runs: [], turns: [], conversation: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, latestTotalTokens: null } },
        pendingApprovals: [],
        artifacts: [],
      }),
    } as unknown as ShiguangBridge;

    const { result } = renderHook(() => useDesktopSessions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeWorkspaceId).toBe("workspace-empty");
    expect(result.current.activeSessionId).toBeNull();
  });
});

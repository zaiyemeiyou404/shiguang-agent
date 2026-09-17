import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopWorkspaceSnapshot, ShiguangBridge } from "../bridge";
import { useSessionWorkspace } from "./useSessionWorkspace";

function snapshot(sessionId: string, runId: string): DesktopWorkspaceSnapshot {
  return {
    detail: {
      session: { id: sessionId, workspaceId: "workspace-1", title: sessionId, status: "active", createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z", summary: null },
      runs: [{ id: runId, sessionId, status: "completed", reason: null, startedAt: "2026-09-17T00:00:00Z", endedAt: "2026-09-17T00:00:01Z", summary: null }],
      turns: [], conversation: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, latestTotalTokens: null },
    },
    pendingApprovals: [], artifacts: [],
  };
}

afterEach(() => { delete window.shiguang; });

describe("useSessionWorkspace", () => {
  it("loads the session snapshot and selects its latest run", async () => {
    window.shiguang = { getWorkspaceSnapshot: async () => snapshot("session-1", "run-1") } as unknown as ShiguangBridge;
    const { result } = renderHook(() => useSessionWorkspace("session-1"));
    await waitFor(() => expect(result.current.activeRunId).toBe("run-1"));
    expect(result.current.detail?.session.id).toBe("session-1");
  });

  it("ignores a stale snapshot after the selected session changes", async () => {
    const resolvers = new Map<string, (value: DesktopWorkspaceSnapshot) => void>();
    window.shiguang = { getWorkspaceSnapshot: (id: string) => new Promise((resolve) => resolvers.set(id, resolve)) } as unknown as ShiguangBridge;
    const { result, rerender } = renderHook(({ id }) => useSessionWorkspace(id), { initialProps: { id: "session-1" as string | null } });
    rerender({ id: "session-2" });
    act(() => resolvers.get("session-1")?.(snapshot("session-1", "run-1")));
    act(() => resolvers.get("session-2")?.(snapshot("session-2", "run-2")));
    await waitFor(() => expect(result.current.detail?.session.id).toBe("session-2"));
    expect(result.current.activeRunId).toBe("run-2");
  });
});

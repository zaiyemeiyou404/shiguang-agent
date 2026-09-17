import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopEvent, ShiguangBridge } from "../bridge";
import { useRunActivity } from "./useRunActivity";

function systemEvent(id: string, seq: number): DesktopEvent {
  return { id, runId: "run-1", seq, kind: "system", payload: { message: id }, createdAt: `2026-09-17T00:00:0${seq}.000Z` };
}

afterEach(() => {
  delete window.shiguang;
});

describe("useRunActivity", () => {
  it("subscribes before fetching and merges live events arriving during hydration", async () => {
    let resolveHistory!: (events: DesktopEvent[]) => void;
    let callback: ((event: DesktopEvent) => void) | null = null;
    const order: string[] = [];
    const unsubscribe = vi.fn();
    window.shiguang = {
      subscribeRunEvents: (_runId: string, next: (event: DesktopEvent) => void) => { order.push("subscribe"); callback = next; return unsubscribe; },
      getRunEvents: () => { order.push("fetch"); return new Promise((resolve) => { resolveHistory = resolve; }); },
    } as unknown as ShiguangBridge;

    const { result, unmount } = renderHook(() => useRunActivity("run-1"));
    expect(order).toEqual(["subscribe", "fetch"]);
    act(() => callback?.(systemEvent("live", 2)));
    act(() => resolveHistory([systemEvent("history", 1), systemEvent("live", 2)]));

    await waitFor(() => expect(result.current.events.map((event) => event.id)).toEqual(["history", "live"]));
    expect(result.current.streamState).toBe("live");
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("cleans up and ignores stale history when switching runs", async () => {
    const resolvers = new Map<string, (events: DesktopEvent[]) => void>();
    const releases: string[] = [];
    window.shiguang = {
      subscribeRunEvents: (runId: string) => () => { releases.push(runId); },
      getRunEvents: (runId: string) => new Promise((resolve) => { resolvers.set(runId, resolve); }),
    } as unknown as ShiguangBridge;

    const { result, rerender } = renderHook(({ runId }) => useRunActivity(runId), { initialProps: { runId: "run-1" as string | null } });
    rerender({ runId: "run-2" });
    expect(releases).toContain("run-1");
    act(() => resolvers.get("run-1")?.([systemEvent("stale", 1)]));
    act(() => resolvers.get("run-2")?.([{ ...systemEvent("current", 1), runId: "run-2" }]));
    await waitFor(() => expect(result.current.events.map((event) => event.id)).toEqual(["current"]));
  });
});

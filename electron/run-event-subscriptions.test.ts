import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "./types.js";
import { RunEventSubscriptionRegistry, type RunEventSender } from "./run-event-subscriptions.js";

function fakeSender(id = 7) {
  let destroyed = false;
  let destroyListener = () => {};
  const sent: Array<{ channel: string; event: DesktopEvent }> = [];
  const sender: RunEventSender = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, event) => sent.push({ channel, event }),
    once: (_event, listener) => { destroyListener = listener; },
  };
  return {
    sender,
    sent,
    destroy: () => { destroyed = true; destroyListener(); },
  };
}

describe("RunEventSubscriptionRegistry", () => {
  it("releases replaced, explicit, and sender-destroyed subscriptions", () => {
    const callbacks = new Map<string, (event: DesktopEvent) => void>();
    const releases: string[] = [];
    const source = {
      subscribeRunEvents: vi.fn((runId: string, callback: (event: DesktopEvent) => void) => {
        callbacks.set(runId, callback);
        return () => releases.push(runId);
      }),
    };
    const registry = new RunEventSubscriptionRegistry(source);
    const first = fakeSender();

    registry.subscribe(first.sender, "run-1", "sub-1");
    registry.subscribe(first.sender, "run-2", "sub-1");
    expect(releases).toEqual(["run-1"]);
    expect(registry.size).toBe(1);

    registry.unsubscribe(first.sender.id, "sub-1");
    expect(releases).toEqual(["run-1", "run-2"]);
    expect(registry.size).toBe(0);

    registry.subscribe(first.sender, "run-3", "sub-2");
    first.destroy();
    expect(releases).toEqual(["run-1", "run-2", "run-3"]);
    expect(registry.size).toBe(0);
  });

  it("isolates channels by subscription id", () => {
    let callback: (event: DesktopEvent) => void = () => {};
    const registry = new RunEventSubscriptionRegistry({
      subscribeRunEvents: (_runId, next) => { callback = next; return () => {}; },
    });
    const target = fakeSender();
    registry.subscribe(target.sender, "run-1", "sub-A");
    callback({
      id: "event-1",
      runId: "run-1",
      seq: 1,
      kind: "system",
      payload: { message: "ok" },
      createdAt: "2026-09-17T00:00:00.000Z",
    });
    expect(target.sent[0]?.channel).toBe("run-event:sub-A");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { IpcRenderer } from "electron";

import {
  SHIGUANG_BRIDGE_METHODS,
  assertShiguangBridge,
  createShiguangBridge,
} from "./preload-bridge.js";

function fakeIpcRenderer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const invoke = vi.fn(async () => undefined);
  const ipcRenderer = {
    invoke,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener); }),
    removeListener: vi.fn((channel: string) => { listeners.delete(channel); }),
  } as unknown as IpcRenderer;
  return { ipcRenderer, invoke, listeners };
}

describe("preload bridge contract", () => {
  it("exposes every required method and routes calls through explicit IPC channels", async () => {
    const { ipcRenderer, invoke } = fakeIpcRenderer();
    const bridge = createShiguangBridge(ipcRenderer);
    expect(Object.keys(bridge).sort()).toEqual([...SHIGUANG_BRIDGE_METHODS].sort());
    await bridge.createProject({ name: "Project" });
    expect(invoke).toHaveBeenCalledWith("createProject", { name: "Project" });
  });

  it("fails closed when a required bridge method is absent", () => {
    const { ipcRenderer } = fakeIpcRenderer();
    const bridge = createShiguangBridge(ipcRenderer);
    const incomplete = { ...bridge } as Partial<typeof bridge>;
    delete incomplete.sendUserMessage;
    expect(() => assertShiguangBridge(incomplete)).toThrow(/sendUserMessage/);
  });
});

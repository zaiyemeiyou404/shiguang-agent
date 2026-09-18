import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSession } from "./types.js";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

const originalUserDataDir = process.env.SHIGUANG_USER_DATA_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalUserDataDir === undefined) delete process.env.SHIGUANG_USER_DATA_DIR;
  else process.env.SHIGUANG_USER_DATA_DIR = originalUserDataDir;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopStore session persistence characterization", () => {
  it("preserves create, list, update, and delete responses across restarts", async () => {
    const userDataRoot = mkdtempSync(join(tmpdir(), "shiguang-store-characterization-"));
    temporaryDirectories.push(userDataRoot);
    process.env.SHIGUANG_USER_DATA_DIR = userDataRoot;
    const { DesktopStore } = await import("./store.js");

    const session: DesktopSession = {
      id: "sess-characterization",
      workspaceId: "workspace-default",
      title: "Original title",
      status: "active",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      summary: null,
      workspaceRoot: "G:/workspace",
    };

    const firstProcess = new DesktopStore();
    expect(firstProcess.listSessions()).toEqual([]);
    expect(firstProcess.createSession(session)).toEqual(session);
    expect(firstProcess.listSessions()).toEqual([session]);

    const afterCreateRestart = new DesktopStore();
    expect(afterCreateRestart.listSessions()).toEqual([session]);
    expect(afterCreateRestart.updateSession(session.id, {
      title: "Renamed session",
      status: "archived",
      updatedAt: "2026-09-18T00:05:00.000Z",
    })).toEqual({
      ...session,
      title: "Renamed session",
      status: "archived",
      updatedAt: "2026-09-18T00:05:00.000Z",
    });

    const afterUpdateRestart = new DesktopStore();
    expect(afterUpdateRestart.listSessions()).toEqual([{
      ...session,
      title: "Renamed session",
      status: "archived",
      updatedAt: "2026-09-18T00:05:00.000Z",
    }]);
    expect(afterUpdateRestart.deleteSession(session.id)).toBe(true);
    expect(afterUpdateRestart.deleteSession(session.id)).toBe(false);

    const afterDeleteRestart = new DesktopStore();
    expect(afterDeleteRestart.listSessions()).toEqual([]);
  });
});

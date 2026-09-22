import { describe, expect, it } from "vitest";

import { sortSessionsForSidebar } from "./session-order";

const session = (id: string, updatedAt: string) => ({
  id,
  workspaceId: "workspace-1",
  title: id,
  status: "active" as const,
  createdAt: updatedAt,
  updatedAt,
  summary: null,
});

describe("sortSessionsForSidebar", () => {
  it("does not reorder sessions simply because one is selected", () => {
    const newer = session("newer", "2026-09-22T12:00:00.000Z");
    const older = session("older", "2026-09-22T11:00:00.000Z");

    expect(sortSessionsForSidebar([older, newer], [], "older").map((item) => item.id)).toEqual(["newer", "older"]);
  });
});

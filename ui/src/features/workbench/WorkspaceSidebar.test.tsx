import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

describe("WorkspaceSidebar", () => {
  it("keeps an explicitly selected empty workspace highlighted", () => {
    render(
      <WorkspaceSidebar
        projects={[{ id: "project-1", name: "默认项目" }]}
        workspaces={[
          { id: "workspace-empty", projectId: "project-1", name: "空工作区", rootPath: "G:/empty", available: true },
          { id: "workspace-active", projectId: "project-1", name: "有会话工作区", rootPath: "G:/active", available: true },
        ]}
        sessions={[{ id: "session-1", workspaceId: "workspace-active", title: "Default Session", status: "active" }]}
        activeWorkspaceId="workspace-empty"
        activeSessionId={null}
        onSelectWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /空工作区/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("Default Session")).toBeNull();
  });
});

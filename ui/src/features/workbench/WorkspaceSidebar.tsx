import type { ReactNode } from "react";
import type { DesktopProject, DesktopSession, DesktopWorkspace } from "../../bridge";

type WorkspaceSidebarProps = {
  projects: Pick<DesktopProject, "id" | "name">[];
  workspaces: Pick<DesktopWorkspace, "id" | "projectId" | "name" | "rootPath" | "available">[];
  sessions: Pick<DesktopSession, "id" | "workspaceId" | "title" | "status">[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  renderSession?: (session: Pick<DesktopSession, "id" | "workspaceId" | "title" | "status">) => ReactNode;
  emptyWorkspaceAction?: (workspaceId: string) => ReactNode;
};

export function WorkspaceSidebar({
  projects,
  workspaces,
  sessions,
  activeWorkspaceId,
  activeSessionId,
  onSelectWorkspace,
  onSelectSession,
  renderSession,
  emptyWorkspaceAction,
}: WorkspaceSidebarProps) {
  return (
    <nav aria-label="项目、工作区和会话">
      {projects.map((project) => {
        const projectWorkspaces = workspaces.filter((workspace) => workspace.projectId === project.id);
        return (
          <section className="project-group" key={project.id}>
            <div className="project-group-title"><span>{project.name}</span><small>{projectWorkspaces.length}</small></div>
            {projectWorkspaces.map((workspace) => {
              const selected = workspace.id === activeWorkspaceId;
              const workspaceSessions = selected
                ? sessions.filter((session) => session.workspaceId === workspace.id)
                : [];
              return (
                <div className={`workspace-group${selected ? " active" : ""}`} key={workspace.id}>
                  <button
                    className="workspace-group-head"
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  >
                    <span className="workspace-group-icon">◇</span>
                    <span className="workspace-group-copy">
                      <strong>{workspace.name}</strong>
                      <small>{workspace.available ? workspace.rootPath : "目录不可用"}</small>
                    </span>
                    <span className={`workspace-state-dot${workspace.available ? "" : " unavailable"}`} />
                  </button>
                  {selected ? (
                    <div className="workspace-session-list">
                      {workspaceSessions.map((session) => renderSession ? renderSession(session) : (
                        <button
                          aria-current={session.id === activeSessionId ? "page" : undefined}
                          className={`workspace-session-link${session.id === activeSessionId ? " active" : ""}`}
                          key={session.id}
                          onClick={() => onSelectSession(session.id)}
                          type="button"
                        >
                          <span>{session.title}</span>
                          <small>{session.status === "archived" ? "已归档" : ""}</small>
                        </button>
                      ))}
                      {workspaceSessions.length === 0 ? emptyWorkspaceAction?.(workspace.id) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}

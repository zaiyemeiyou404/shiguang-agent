import { useState, useEffect, useCallback } from "react";
import { getDesktopBridgeErrorMessage, requireDesktopBridge } from "../bridge";
import type { DesktopSession, DesktopRun, DesktopSessionDetail, DesktopWorkspaceSnapshot, DesktopProject, DesktopWorkspace, CreateWorkspaceRequest } from "../bridge";
import { useSessionWorkspace } from "./useSessionWorkspace";

export { useRunEvents } from "./useRunActivity";

export function useDesktopSessions() {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [workspaces, setWorkspaces] = useState<DesktopWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() => localStorage.getItem("shiguang.activeWorkspaceId"));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const { detail, workspaceSnapshot, activeRunId, setActiveRunId, detailError, refreshDetail, clearWorkspace } = useSessionWorkspace(activeSessionId);

  const refreshSessions = useCallback(async () => {
    try {
      const bridge = requireDesktopBridge();
      setSessionError(null);
      const [list, projectList, workspaceList] = await Promise.all([
        bridge.listSessions(),
        bridge.listProjects(),
        bridge.listWorkspaces(),
      ]);
      setProjects(projectList);
      setWorkspaces(workspaceList);
      const preferredWorkspaceId = workspaceList.some((workspace) => workspace.id === activeWorkspaceId)
        ? activeWorkspaceId
        : workspaceList.find((workspace) => workspace.available)?.id ?? workspaceList[0]?.id ?? null;
      setActiveWorkspaceId(preferredWorkspaceId);
      setSessions(list);
      const availableWorkspaceId = workspaceList.find((workspace) => workspace.id === preferredWorkspaceId && workspace.available)?.id
        ?? workspaceList.find((workspace) => workspace.available)?.id
        ?? null;
      if (list.length === 0 && availableWorkspaceId) {
        const session = await bridge.createSession({ title: "Default Session", workspaceId: availableWorkspaceId });
        setSessions([session]);
        setActiveWorkspaceId(session.workspaceId);
        setActiveSessionId(session.id);
      } else if (!activeSessionId || !list.some((session) => session.id === activeSessionId)) {
        const nextSession = list.find((session) => session.workspaceId === preferredWorkspaceId) ?? list[0];
        setActiveSessionId(nextSession?.id ?? null);
        if (nextSession) setActiveWorkspaceId(nextSession.workspaceId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionError(`Failed to load sessions: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId, activeWorkspaceId]);

  useEffect(() => {
    if (activeWorkspaceId) localStorage.setItem("shiguang.activeWorkspaceId", activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    try {
      requireDesktopBridge();
    } catch (error) {
      const message = error instanceof Error ? error.message : getDesktopBridgeErrorMessage();
      setSessionError(message);
      setLoading(false);
      setSessions([]);
      clearWorkspace();
      return;
    }
    void refreshSessions();
  }, [refreshSessions]);

  const createSession = useCallback(async (title?: string, workspaceId = activeWorkspaceId) => {
    if (!workspaceId) throw new Error("请先创建或选择一个工作区。");
    const session = await requireDesktopBridge().createSession({ title, workspaceId });
    await refreshSessions();
    setActiveWorkspaceId(session.workspaceId);
    setActiveSessionId(session.id);
    return session;
  }, [activeWorkspaceId, refreshSessions]);

  const createProject = useCallback(async (name: string) => {
    const project = await requireDesktopBridge().createProject({ name });
    await refreshSessions();
    return project;
  }, [refreshSessions]);

  const createWorkspace = useCallback(async (req: CreateWorkspaceRequest) => {
    const workspace = await requireDesktopBridge().createWorkspace(req);
    await refreshSessions();
    setActiveWorkspaceId(workspace.id);
    setActiveSessionId(null);
    clearWorkspace();
    return workspace;
  }, [clearWorkspace, refreshSessions]);

  const branchSession = useCallback(async (runId: string, title?: string) => {
    const result = await requireDesktopBridge().branchSession({ runId, title });
    await refreshSessions();
    setActiveWorkspaceId(result.session.workspaceId);
    setActiveSessionId(result.session.id);
    setActiveRunId(null);
    return result;
  }, [refreshSessions]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const session = await requireDesktopBridge().renameSession({ sessionId, title });
    await refreshSessions();
    if (activeSessionId === sessionId) {
      await refreshDetail();
    }
    return session;
  }, [activeSessionId, refreshDetail, refreshSessions]);

  const updateSessionStatus = useCallback(async (sessionId: string, status: DesktopSession["status"]) => {
    const session = await requireDesktopBridge().updateSessionStatus({ sessionId, status });
    await refreshSessions();
    if (activeSessionId === sessionId) {
      await refreshDetail();
    }
    return session;
  }, [activeSessionId, refreshDetail, refreshSessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await requireDesktopBridge().deleteSession({ sessionId });
    if (activeSessionId === sessionId) {
      clearWorkspace();
      setActiveSessionId(null);
    }
    await refreshSessions();
  }, [activeSessionId, clearWorkspace, refreshSessions]);

  const selectSession = useCallback((id: string) => {
    const session = sessions.find((item) => item.id === id);
    if (session) setActiveWorkspaceId(session.workspaceId);
    setActiveSessionId(id);
    setActiveRunId(null);
  }, [sessions]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    const nextSession = sessions.find((session) => session.workspaceId === workspaceId) ?? null;
    setActiveSessionId(nextSession?.id ?? null);
    clearWorkspace();
  }, [clearWorkspace, sessions]);

  return { projects, workspaces, activeWorkspaceId, setActiveWorkspaceId, sessions, activeSessionId, detail, workspaceSnapshot, activeRunId, setActiveRunId, loading, sessionError, detailError, createProject, createWorkspace, createSession, branchSession, renameSession, updateSessionStatus, deleteSession, selectSession, selectWorkspace, refreshSessions, refreshDetail };
}

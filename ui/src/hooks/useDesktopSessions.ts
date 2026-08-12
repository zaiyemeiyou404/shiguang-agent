import { useState, useEffect, useCallback } from "react";
import { getDesktopBridgeErrorMessage, requireDesktopBridge } from "../bridge";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSessionDetail, DesktopWorkspaceSnapshot } from "../bridge";

export function useDesktopSessions() {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DesktopSessionDetail | null>(null);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<DesktopWorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const bridge = requireDesktopBridge();
      setSessionError(null);
      const list = await bridge.listSessions();
      setSessions(list);
      if (list.length === 0) {
        const session = await bridge.createSession("Default Session");
        setSessions([session]);
        setActiveSessionId(session.id);
      } else if (!activeSessionId || !list.some((session) => session.id === activeSessionId)) {
        setActiveSessionId(list[0].id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionError(`Failed to load sessions: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    try {
      requireDesktopBridge();
    } catch (error) {
      const message = error instanceof Error ? error.message : getDesktopBridgeErrorMessage();
      setSessionError(message);
      setLoading(false);
      setSessions([]);
      setDetail(null);
      setActiveRunId(null);
      return;
    }
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (activeSessionId) {
      const bridge = requireDesktopBridge();
      setDetailError(null);
      void bridge.getWorkspaceSnapshot(activeSessionId).then((snapshot) => {
        const d = snapshot.detail;
        setWorkspaceSnapshot(snapshot);
        setDetail(d);
        if (d.runs.length > 0) {
          const latest = d.runs.reduce((a, b) => ((a.startedAt ?? a.id) > (b.startedAt ?? b.id) ? a : b));
          if (latest.status === "pending" || latest.status === "running" || latest.status === "paused" || latest.status === "needs_approval") {
            setActiveRunId(latest.id);
          } else if (!activeRunId) {
            setActiveRunId(latest.id);
          }
        } else {
          setActiveRunId(null);
        }
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setDetailError(`Failed to load session detail: ${message}`);
      });
    }
  }, [activeSessionId, activeRunId]);

  const refreshDetail = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const bridge = requireDesktopBridge();
      setDetailError(null);
      const snapshot = await bridge.getWorkspaceSnapshot(activeSessionId);
      setWorkspaceSnapshot(snapshot);
      setDetail(snapshot.detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDetailError(`Failed to refresh session detail: ${message}`);
    }
  }, [activeSessionId]);


  const createSession = useCallback(async (title?: string) => {
    const session = await requireDesktopBridge().createSession(title);
    await refreshSessions();
    setActiveSessionId(session.id);
    return session;
  }, [refreshSessions]);

  const branchSession = useCallback(async (runId: string, title?: string) => {
    const result = await requireDesktopBridge().branchSession({ runId, title });
    await refreshSessions();
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
      setDetail(null);
      setWorkspaceSnapshot(null);
      setActiveRunId(null);
      setActiveSessionId(null);
    }
    await refreshSessions();
  }, [activeSessionId, refreshSessions]);

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setActiveRunId(null);
  }, []);

  return { sessions, activeSessionId, detail, workspaceSnapshot, activeRunId, setActiveRunId, loading, sessionError, detailError, createSession, branchSession, renameSession, updateSessionStatus, deleteSession, selectSession, refreshSessions, refreshDetail };
}

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<DesktopEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "error">("idle");

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setEventsError(null);
      setStreamState("idle");
      return;
    }

    let cancelled = false;
    let bridge: ReturnType<typeof requireDesktopBridge>;
    try {
      bridge = requireDesktopBridge();
    } catch (error) {
      const message = error instanceof Error ? error.message : getDesktopBridgeErrorMessage();
      setEvents([]);
      setEventsError(message);
      setStreamState("error");
      return;
    }
    setEventsError(null);
    setStreamState("connecting");

    void bridge.getRunEvents(runId).then((persisted) => {
      if (cancelled) return;
      setEvents(persisted.sort((a, b) => a.seq - b.seq));
      setEventsError(null);
      setStreamState("live");
    }).catch((error) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      setEventsError(`Failed to load run timeline: ${message}`);
      setStreamState("error");
    });

    let unsub = () => {};
    try {
      unsub = bridge.subscribeRunEvents(runId, (event) => {
        setStreamState("live");
        setEventsError(null);
        setEvents((prev) => {
          const exists = prev.some((e) => e.id === event.id);
          if (exists) return prev;
          return [...prev, event].sort((a, b) => a.seq - b.seq);
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEventsError(`Failed to subscribe to run events: ${message}`);
      setStreamState("error");
    }

    return () => {
      cancelled = true;
      unsub();
    };
  }, [runId]);

  return { events, eventsError, streamState };
}

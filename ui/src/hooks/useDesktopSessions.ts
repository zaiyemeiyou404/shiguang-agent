import { useState, useEffect, useCallback } from "react";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSessionDetail } from "../bridge";

export function useDesktopSessions() {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DesktopSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await window.shiguang.listSessions();
      setSessions(list);
      if (list.length === 0) {
        const session = await window.shiguang.createSession("Default Session");
        setSessions([session]);
        setActiveSessionId(session.id);
      } else if (!activeSessionId) {
        setActiveSessionId(list[0].id);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (activeSessionId) {
      window.shiguang.getSessionDetail(activeSessionId).then((d) => {
        setDetail(d);
        if (d.runs.length > 0) {
          const latest = d.runs.reduce((a, b) => ((a.startedAt ?? a.id) > (b.startedAt ?? b.id) ? a : b));
          if (latest.status === "pending" || latest.status === "running" || latest.status === "needs_approval") {
            setActiveRunId(latest.id);
          } else if (!activeRunId) {
            setActiveRunId(latest.id);
          }
        } else {
          setActiveRunId(null);
        }
      }).catch(() => {});
    }
  }, [activeSessionId]);

  const createSession = useCallback(async (title?: string) => {
    const session = await window.shiguang.createSession(title);
    await refreshSessions();
    setActiveSessionId(session.id);
    return session;
  }, [refreshSessions]);

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setActiveRunId(null);
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const d = await window.shiguang.getSessionDetail(activeSessionId);
      setDetail(d);
    } catch {}
  }, [activeSessionId]);

  return { sessions, activeSessionId, detail, activeRunId, setActiveRunId, loading, createSession, selectSession, refreshSessions, refreshDetail };
}

export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<DesktopEvent[]>([]);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      return;
    }

    let cancelled = false;

    void window.shiguang.getRunEvents(runId).then((persisted) => {
      if (cancelled) return;
      setEvents(persisted.sort((a, b) => a.seq - b.seq));
    });

    const unsub = window.shiguang.subscribeRunEvents(runId, (event) => {
      setEvents((prev) => {
        const exists = prev.some((e) => e.id === event.id);
        if (exists) return prev;
        return [...prev, event].sort((a, b) => a.seq - b.seq);
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [runId]);

  return events;
}

import { useCallback, useEffect, useRef, useState } from "react";

import { requireDesktopBridge } from "../bridge";
import type { DesktopSessionDetail, DesktopWorkspaceSnapshot } from "../bridge";

function latestRunId(detail: DesktopSessionDetail): string | null {
  if (detail.runs.length === 0) return null;
  return detail.runs.reduce((latest, run) => {
    const latestKey = latest.startedAt ?? latest.endedAt ?? latest.id;
    const nextKey = run.startedAt ?? run.endedAt ?? run.id;
    return nextKey > latestKey ? run : latest;
  }).id;
}

export function useSessionWorkspace(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceSnapshot | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const generation = useRef(0);

  const applySnapshot = useCallback((next: DesktopWorkspaceSnapshot, preserveRun: boolean) => {
    setSnapshot(next);
    setActiveRunId((current) => preserveRun && current && next.detail.runs.some((run) => run.id === current)
      ? current
      : latestRunId(next.detail));
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!sessionId) return null;
    const request = ++generation.current;
    try {
      setDetailError(null);
      const next = await requireDesktopBridge().getWorkspaceSnapshot(sessionId);
      if (request !== generation.current) return null;
      applySnapshot(next, true);
      return next;
    } catch (error) {
      if (request !== generation.current) return null;
      setDetailError(`Failed to refresh session detail: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [applySnapshot, sessionId]);

  const clear = useCallback(() => {
    generation.current += 1;
    setSnapshot(null);
    setActiveRunId(null);
    setDetailError(null);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      clear();
      return;
    }
    const request = ++generation.current;
    setSnapshot(null);
    setActiveRunId(null);
    setDetailError(null);
    void requireDesktopBridge().getWorkspaceSnapshot(sessionId).then((next) => {
      if (request !== generation.current) return;
      applySnapshot(next, false);
    }).catch((error) => {
      if (request !== generation.current) return;
      setDetailError(`Failed to load session detail: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [applySnapshot, clear, sessionId]);

  return {
    detail: snapshot?.detail ?? null,
    workspaceSnapshot: snapshot,
    activeRunId,
    setActiveRunId,
    detailError,
    refreshDetail,
    clearWorkspace: clear,
  };
}

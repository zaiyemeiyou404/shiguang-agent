import type { DesktopSession } from "../../bridge";

function sessionPriority(session: DesktopSession): number {
  let score = 0;
  if (session.attention?.hasPendingApproval) score += 500 + (session.attention.pendingApprovalCount * 10);
  if (session.attention?.hasRunningRun) score += 300;
  if (session.attention?.hasFailedRun) score += 200;
  if (session.attention?.hasContextCompaction) score += 50;
  if (session.status === "active") score += 20;
  return score;
}

export function sortSessionsForSidebar(
  sessions: readonly DesktopSession[],
  pinnedSessionIds: readonly string[],
  _activeSessionId: string | null,
): DesktopSession[] {
  return [...sessions].sort((a, b) => {
    const aPinned = pinnedSessionIds.includes(a.id) ? 1 : 0;
    const bPinned = pinnedSessionIds.includes(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const priorityDiff = sessionPriority(b) - sessionPriority(a);
    if (priorityDiff !== 0) return priorityDiff;
    return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
  });
}

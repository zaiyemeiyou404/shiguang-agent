export interface DesktopSession {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
}

export interface DesktopRun {
  id: string;
  sessionId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "needs_approval";
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
}

export interface DesktopEvent {
  id: string;
  runId: string;
  seq: number;
  kind: "thinking" | "message" | "tool_call" | "tool_result" | "error" | "system" | "approval_request" | "approval_granted" | "approval_denied";
  payload: unknown;
  createdAt: string;
}

export interface DesktopSessionDetail {
  session: DesktopSession;
  runs: DesktopRun[];
}

export interface SendMessageRequest {
  sessionId: string;
  message: string;
}

export interface ShiguangBridge {
  listSessions(): Promise<DesktopSession[]>;
  createSession(title?: string): Promise<DesktopSession>;
  getSessionDetail(sessionId: string): Promise<DesktopSessionDetail>;
  sendUserMessage(req: SendMessageRequest): Promise<DesktopRun>;
  getRunEvents(runId: string): Promise<DesktopEvent[]>;
  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void;
}

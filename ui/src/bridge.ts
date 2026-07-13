export interface DesktopSessionAttention {
  latestRunStatus: DesktopRun["status"] | null;
  hasRunningRun: boolean;
  hasPendingApproval: boolean;
  pendingApprovalCount: number;
  hasFailedRun: boolean;
  hasContextCompaction: boolean;
}

export interface DesktopSession {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  attention?: DesktopSessionAttention;
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
  kind: "thinking" | "message" | "tool_call" | "tool_result" | "error" | "system" | "approval_request" | "approval_granted" | "approval_denied" | "context_compacted";
  payload: unknown;
  createdAt: string;
}

export interface DesktopApproval {
  id: string;
  runId: string;
  pluginId: string;
  capability: string;
  status: "pending" | "granted" | "denied" | "expired";
  request: unknown;
  decidedAt: string | null;
}

export interface DesktopArtifact {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  kind: string;
  uri: string;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalDecisionRequest {
  approvalId: string;
  decision: "granted" | "denied";
}

export interface RunActionRequest {
  runId: string;
}

export interface DesktopSessionDetail {
  session: DesktopSession;
  runs: DesktopRun[];
}

export interface SendMessageRequest {
  sessionId: string;
  message: string;
}

export interface DesktopSettings {
  configPath: string;
  workspaceRoot: string;
  llm: {
    provider: string;
    model?: string;
    maxTokens?: number;
  };
  providers: Record<string, {
    type?: "openai-compatible" | "anthropic" | "gemini";
    authMode?: "api_key" | "none";
    baseURL?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    model?: string;
    maxTokens?: number;
  }>;
}

export interface ShiguangBridge {
  listSessions(): Promise<DesktopSession[]>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: DesktopSettings): Promise<DesktopSettings>;
  createSession(title?: string): Promise<DesktopSession>;
  getSessionDetail(sessionId: string): Promise<DesktopSessionDetail>;
  listArtifacts(sessionId: string, runId?: string): Promise<DesktopArtifact[]>;
  sendUserMessage(req: SendMessageRequest): Promise<DesktopRun>;
  getRunEvents(runId: string): Promise<DesktopEvent[]>;
  listPendingApprovals(sessionId: string): Promise<DesktopApproval[]>;
  decideApproval(req: ApprovalDecisionRequest): Promise<DesktopApproval>;
  cancelRun(req: RunActionRequest): Promise<DesktopRun>;
  retryRun(req: RunActionRequest): Promise<DesktopRun>;
  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void;
}

export function getDesktopBridge(): ShiguangBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = (window as Window & { shiguang?: ShiguangBridge }).shiguang;
  return typeof bridge === "object" && bridge ? bridge : null;
}

export function getDesktopBridgeErrorMessage(): string {
  return "This renderer needs the Electron desktop host. Start it with `npm run desktop:dev` or launch the packaged desktop app instead of opening the Vite page directly in a browser.";
}

export function requireDesktopBridge(): ShiguangBridge {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error(getDesktopBridgeErrorMessage());
  }
  return bridge;
}

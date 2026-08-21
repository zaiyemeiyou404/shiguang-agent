export interface DesktopSessionAttention {
  latestRunStatus: DesktopRun["status"] | null;
  hasRunningRun: boolean;
  hasPendingApproval: boolean;
  pendingApprovalCount: number;
  hasFailedRun: boolean;
  hasContextCompaction: boolean;
}

export interface DesktopTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  latestTotalTokens: number | null;
}

export interface DesktopSession {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  workspaceRoot?: string | null;
  tokenUsage?: DesktopTokenUsage;
  attention?: DesktopSessionAttention;
}

export interface DesktopRun {
  id: string;
  sessionId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled" | "needs_approval";
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  tokenUsage?: DesktopTokenUsage;
}

export interface DesktopTurn {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface DesktopConversationEntry {
  id: string;
  sessionId: string;
  runId: string | null;
  source: "turn" | "event";
  kind: "message" | "system" | "error" | "approval_request" | "approval_granted" | "approval_denied";
  role: "user" | "assistant" | "system";
  from: string;
  content: string;
  payload?: unknown;
  createdAt: string;
}

export interface DesktopEvent {
  id: string;
  runId: string;
  seq: number;
  kind: "thinking" | "message" | "tool_call" | "tool_result" | "tool_pipeline" | "error" | "system" | "approval_request" | "approval_granted" | "approval_denied" | "model_usage" | "context_compacted";
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

export interface SessionRenameRequest {
  sessionId: string;
  title: string;
}

export interface SessionStatusRequest {
  sessionId: string;
  status: DesktopSession["status"];
}

export interface SessionDeleteRequest {
  sessionId: string;
}

export interface SessionBranchRequest {
  runId: string;
  title?: string;
}

export interface DesktopSessionBranchResult {
  session: DesktopSession;
  sourceSession: DesktopSession;
  sourceRun: DesktopRun;
  suggestedPrompt: string;
}

export interface DesktopSessionDetail {
  session: DesktopSession;
  runs: DesktopRun[];
  turns: DesktopTurn[];
  conversation: DesktopConversationEntry[];
  tokenUsage: DesktopTokenUsage;
}

export interface DesktopWorkspaceSnapshot {
  detail: DesktopSessionDetail;
  pendingApprovals: DesktopApproval[];
  artifacts: DesktopArtifact[];
}

export interface SendMessageRequest {
  sessionId: string;
  message: string;
  attachments?: DesktopAttachment[];
}

export interface ArtifactActionRequest {
  uri: string;
}

export interface ArtifactActionResult {
  uri: string;
  targetPath: string;
}

export interface DesktopAttachment {
  name: string;
  path: string;
  uri: string;
  size: number | null;
}

export interface DesktopProviderSettings {
  type?: "openai-compatible" | "anthropic" | "gemini";
  authMode?: "api_key" | "none";
  baseURL?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  hasStoredApiKey?: boolean;
  apiKeyEnv?: string;
  model?: string;
  maxTokens?: number;
}

export type ToolApprovalMode = "ask" | "workspace_edits";

export interface DesktopMcpServerSettings {
  transport?: "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface DesktopSettings {
  configPath: string;
  workspaceRoot: string;
  toolApprovalMode: ToolApprovalMode;
  llm: {
    provider: string;
    model?: string;
    maxTokens?: number;
  };
  providers: Record<string, DesktopProviderSettings>;
  mcpServers: Record<string, DesktopMcpServerSettings>;
}

export interface DesktopProviderConnectionRequest {
  providerKey: string;
  provider: DesktopProviderSettings;
}

export interface DesktopProviderConnectionResult {
  ok: boolean;
  providerKey: string;
  providerType: "openai-compatible" | "anthropic" | "gemini";
  authSource: "direct" | "env" | "none" | "missing";
  detail: string;
  checkedAt: string;
}

export interface ShiguangBridge {
  listSessions(): Promise<DesktopSession[]>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: DesktopSettings): Promise<DesktopSettings>;
  testProviderConnection(req: DesktopProviderConnectionRequest): Promise<DesktopProviderConnectionResult>;
  createSession(title?: string): Promise<DesktopSession>;
  branchSession(req: SessionBranchRequest): Promise<DesktopSessionBranchResult>;
  renameSession(req: SessionRenameRequest): Promise<DesktopSession>;
  updateSessionStatus(req: SessionStatusRequest): Promise<DesktopSession>;
  deleteSession(req: SessionDeleteRequest): Promise<{ sessionId: string }>;
  getSessionDetail(sessionId: string): Promise<DesktopSessionDetail>;
  getWorkspaceSnapshot(sessionId: string): Promise<DesktopWorkspaceSnapshot>;
  listArtifacts(sessionId: string, runId?: string): Promise<DesktopArtifact[]>;
  openArtifact(req: ArtifactActionRequest): Promise<ArtifactActionResult>;
  revealArtifact(req: ArtifactActionRequest): Promise<ArtifactActionResult>;
  pickAttachments(): Promise<DesktopAttachment[]>;
  sendUserMessage(req: SendMessageRequest): Promise<DesktopRun>;
  getRunEvents(runId: string): Promise<DesktopEvent[]>;
  listPendingApprovals(sessionId: string): Promise<DesktopApproval[]>;
  decideApproval(req: ApprovalDecisionRequest): Promise<DesktopApproval>;
  cancelRun(req: RunActionRequest): Promise<DesktopRun>;
  pauseRun(req: RunActionRequest): Promise<DesktopRun>;
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

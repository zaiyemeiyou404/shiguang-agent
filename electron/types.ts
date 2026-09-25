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
  workspaceId: string;
  title: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  workspaceRoot?: string | null;
  llm?: DesktopSessionLlmSettings | null;
  tokenUsage?: DesktopTokenUsage;
  attention?: DesktopSessionAttention;
}

export interface DesktopSessionLlmSettings {
  provider?: string;
  model?: string;
  maxTokens?: number;
}

export interface DesktopProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWorkspace {
  id: string;
  projectId: string;
  name: string;
  rootPath: string;
  available: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRequest {
  name: string;
}

export interface CreateWorkspaceRequest {
  projectId: string;
  name: string;
  rootPath: string;
}

export interface CreateSessionRequest {
  title?: string;
  workspaceId: string;
}

export interface DesktopRun {
  id: string;
  sessionId: string;
  status: "pending" | "running" | "paused" | "waiting_user" | "blocked" | "verifying" | "completed" | "failed" | "cancelled" | "needs_approval";
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  tokenUsage?: DesktopTokenUsage;
  checkpoints?: DesktopTaskCheckpoint[];
  budget?: { maxSteps: number; stepsUsed: number } | null;
}

export interface DesktopTaskCheckpoint {
  id: string;
  taskId: string;
  runId: string | null;
  kind: "planned" | "progress" | "waiting_approval" | "waiting_user" | "verifying" | "completed" | "blocked" | "cancelled" | "failed";
  title: string;
  summary: string | null;
  createdAt: string;
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

export type DesktopEventKind = "thinking" | "message" | "tool_call" | "tool_result" | "tool_pipeline" | "error" | "system" | "approval_request" | "approval_granted" | "approval_denied" | "model_usage" | "context_compacted";

export interface DesktopMessageEventPayload extends Record<string, unknown> {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface DesktopThinkingEventPayload extends Record<string, unknown> {
  content: string;
}

export interface DesktopToolCallEventPayload extends Record<string, unknown> {
  toolCallId: string | null;
  tool: string;
  input: unknown;
  arguments: unknown;
}

export interface DesktopToolResultEventPayload extends Record<string, unknown> {
  toolCallId: string | null;
  tool: string;
  output: unknown;
  isError: boolean;
  error?: string;
}

export interface DesktopNoticeEventPayload extends Record<string, unknown> {
  message: string;
  code?: string;
  approvalId?: string;
}

export interface DesktopApprovalRequestEventPayload extends Record<string, unknown> {
  approvalId: string | null;
  pluginId: string;
  capability: string;
  request: DesktopApprovalRequest;
}

export type DesktopEventPayload =
  | DesktopMessageEventPayload
  | DesktopThinkingEventPayload
  | DesktopToolCallEventPayload
  | DesktopToolResultEventPayload
  | DesktopNoticeEventPayload
  | DesktopApprovalRequestEventPayload;

export interface DesktopEvent {
  id: string;
  runId: string;
  seq: number;
  kind: DesktopEventKind;
  payload: DesktopEventPayload;
  createdAt: string;
}

export interface DesktopApprovalPreview extends Record<string, unknown> {
  kind: string;
  title: string;
  path: string | null;
  operation: string | null;
  diff: string | null;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
  warnings: string[];
}

export interface DesktopApprovalRequest extends Record<string, unknown> {
  toolName: string | null;
  toolInput: unknown;
  reason: string | null;
  preview: DesktopApprovalPreview | null;
}

export interface DesktopApproval {
  id: string;
  runId: string;
  pluginId: string;
  capability: string;
  status: "pending" | "granted" | "denied" | "expired";
  request: DesktopApprovalRequest;
  decidedAt: string | null;
  scope?: "once" | "task" | "workspace";
}

export interface DesktopMemory {
  id: string;
  scope: "session" | "task" | "global" | "workspace";
  workspaceScope: string | null;
  kind: "fact" | "insight" | "preference" | "observation" | "decision";
  summary: string;
  content: string;
  salience: number;
  confidence: number;
  sourceType: "session" | "task" | "run" | "artifact" | "user";
  sourceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopMemoryCandidate extends Omit<DesktopMemory, "updatedAt"> {
  status: "pending" | "accepted" | "dismissed";
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
  scope?: "once" | "task" | "workspace";
}

export interface RunActionRequest {
  runId: string;
}

export interface RunEventSubscriptionRequest {
  runId: string;
  subscriptionId: string;
}

export interface RunEventUnsubscribeRequest {
  subscriptionId: string;
}

export interface SessionRenameRequest {
  sessionId: string;
  title: string;
}

export interface SessionStatusRequest {
  sessionId: string;
  status: DesktopSession["status"];
}

export interface SessionWorkspaceRequest {
  sessionId: string;
  workspaceRoot: string;
}

export interface SessionLlmRequest {
  sessionId: string;
  llm: DesktopSessionLlmSettings | null;
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
  executionPreset: "read_only" | "workspace_write" | "workspace_write_network" | "full_access";
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
  listProjects(): Promise<DesktopProject[]>;
  createProject(req: CreateProjectRequest): Promise<DesktopProject>;
  listWorkspaces(): Promise<DesktopWorkspace[]>;
  createWorkspace(req: CreateWorkspaceRequest): Promise<DesktopWorkspace>;
  listSessions(): Promise<DesktopSession[]>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: DesktopSettings): Promise<DesktopSettings>;
  testProviderConnection(req: DesktopProviderConnectionRequest): Promise<DesktopProviderConnectionResult>;
  createSession(req: CreateSessionRequest): Promise<DesktopSession>;
  branchSession(req: SessionBranchRequest): Promise<DesktopSessionBranchResult>;
  renameSession(req: SessionRenameRequest): Promise<DesktopSession>;
  updateSessionStatus(req: SessionStatusRequest): Promise<DesktopSession>;
  updateSessionWorkspace(req: SessionWorkspaceRequest): Promise<DesktopSession>;
  updateSessionLlm(req: SessionLlmRequest): Promise<DesktopSession>;
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
  listReusableApprovals(sessionId: string): Promise<DesktopApproval[]>;
  revokeApprovalScope(approvalId: string): Promise<DesktopApproval>;
  listWorkspaceMemories(sessionId: string): Promise<DesktopMemory[]>;
  forgetWorkspaceMemory(sessionId: string, memoryId: string): Promise<void>;
  listMemoryCandidates(sessionId: string): Promise<DesktopMemoryCandidate[]>;
  acceptMemoryCandidate(sessionId: string, candidateId: string): Promise<DesktopMemory>;
  dismissMemoryCandidate(sessionId: string, candidateId: string): Promise<void>;
  decideApproval(req: ApprovalDecisionRequest): Promise<DesktopApproval>;
  cancelRun(req: RunActionRequest): Promise<DesktopRun>;
  pauseRun(req: RunActionRequest): Promise<DesktopRun>;
  retryRun(req: RunActionRequest): Promise<DesktopRun>;
  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void;
}

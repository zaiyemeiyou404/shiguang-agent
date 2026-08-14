export type SessionStatus = "active" | "paused" | "archived";

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  summary: string | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  sessionId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_approval";

export interface Run {
  id: string;
  sessionId: string;
  taskId: string;
  status: RunStatus;
  reason: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  model: string | null;
  summary: string | null;
}

export type RunEventKind =
  | "thinking"
  | "message"
  | "tool_call"
  | "tool_result"
  | "tool_pipeline"
  | "error"
  | "system"
  | "approval_request"
  | "approval_granted"
  | "approval_denied"
  | "context_compacted";

export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  kind: RunEventKind;
  payload: unknown;
  createdAt: Date;
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolCall {
  id: string;
  runId: string;
  pluginId: string;
  capability: string;
  status: ToolCallStatus;
  input: unknown;
  output: unknown | null;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface Artifact {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  runId: string | null;
  kind: string;
  uri: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export type MemoryScope = "session" | "task" | "global" | "workspace";

export type MemoryKind = "fact" | "insight" | "preference" | "observation" | "decision";

export interface Memory {
  id: string;
  scope: MemoryScope;
  workspaceScope: string | null;
  kind: MemoryKind;
  summary: string;
  content: string;
  salience: number;
  lastAccessedAt: Date | null;
  sourceType: "session" | "task" | "run" | "artifact" | "user";
  sourceId: string;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryLink {
  memoryId: string;
  targetType: "session" | "task" | "run" | "artifact";
  targetId: string;
}

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired";

export interface Approval {
  id: string;
  runId: string;
  pluginId: string;
  capability: string;
  status: ApprovalStatus;
  request: unknown;
  decidedAt: Date | null;
}

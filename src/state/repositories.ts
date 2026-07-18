import type {
  Session,
  Task,
  Turn,
  Run,
  RunEvent,
  Artifact,
  Memory,
  Approval,
} from "../core/types.js";

export interface SessionRepository {
  create(session: Session): Promise<void>;
  get(id: string): Promise<Session | null>;
  update(id: string, patch: Partial<Session>): Promise<void>;
  list(limit?: number, offset?: number): Promise<Session[]>;
}

export interface TaskRepository {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | null>;
  update(id: string, patch: Partial<Task>): Promise<void>;
  listBySession(sessionId: string): Promise<Task[]>;
}

export interface TurnRepository {
  create(turn: Turn): Promise<void>;
  listBySession(sessionId: string, limit?: number): Promise<Turn[]>;
}

export interface RunRepository {
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  update(id: string, patch: Partial<Run>): Promise<void>;
  listByTask(taskId: string): Promise<Run[]>;
}

export interface RunEventRepository {
  create(event: RunEvent): Promise<void>;
  listByRun(runId: string): Promise<RunEvent[]>;
}

export interface ArtifactRepository {
  create(artifact: Artifact): Promise<void>;
  listByTask(taskId: string): Promise<Artifact[]>;
  listBySession(sessionId: string): Promise<Artifact[]>;
}

export interface MemoryRepository {
  create(memory: Memory): Promise<void>;
  get(id: string): Promise<Memory | null>;
  update(id: string, patch: Partial<Memory>): Promise<void>;
  search(scope: string, query: string, limit?: number): Promise<Memory[]>;
  listByWorkspace(workspaceScope: string, limit?: number): Promise<Memory[]>;
}

export interface ApprovalRepository {
  create(approval: Approval): Promise<void>;
  get(id: string): Promise<Approval | null>;
  update(id: string, patch: Partial<Approval>): Promise<void>;
  listPending(runId: string): Promise<Approval[]>;
  listBySession(sessionId: string): Promise<Approval[]>;
}

export interface Repositories {
  sessions: SessionRepository;
  tasks: TaskRepository;
  turns: TurnRepository;
  runs: RunRepository;
  runEvents: RunEventRepository;
  artifacts: ArtifactRepository;
  memories: MemoryRepository;
  approvals: ApprovalRepository;
}

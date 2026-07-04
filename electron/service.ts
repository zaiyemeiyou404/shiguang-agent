import { DesktopStore } from "./store.js";
import { app, BrowserWindow } from "electron";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSessionDetail } from "./types.js";
import { Agent } from "../dist/app/agent.js";
import { RepositoryEventSink } from "../dist/runtime/event-sink.js";
import type { Approval, Artifact, Memory, Run, RunEvent, Session, Task } from "../dist/core/types.js";
import { MemoryService } from "../dist/memory/service.js";
import { openStateDatabase } from "../dist/state/sqlite.js";
import { SqliteApprovalRepository } from "../dist/state/sqlite-approval-repository.js";
import { SqliteArtifactRepository } from "../dist/state/sqlite-artifact-repository.js";
import { SqliteMemoryRepository } from "../dist/state/sqlite-memory-repository.js";
import { SqliteRunEventRepository } from "../dist/state/sqlite-run-event-repository.js";
import { SqliteRunRepository } from "../dist/state/sqlite-run-repository.js";
import { SqliteSessionRepository } from "../dist/state/sqlite-session-repository.js";
import { SqliteTaskRepository } from "../dist/state/sqlite-task-repository.js";
import { SqliteTurnRepository } from "../dist/state/sqlite-turn-repository.js";
import { createReadTextFileTool } from "../dist/tools/builtins/read-text-file.js";
import { createWriteTextFileTool } from "../dist/tools/builtins/write-text-file.js";
import { createRunValidationTool } from "../dist/tools/builtins/run-validation.js";
import { createSearchWorkspaceTool } from "../dist/tools/builtins/search-workspace.js";
import { createPlanner } from "./planner-factory.js";
import { join, resolve, normalize } from "node:path";

let seqCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seqCounter}`;
}

export class DesktopService {
  private store: DesktopStore;
  private windows: Set<BrowserWindow> = new Set();
  private sessionRepository: SqliteSessionRepository;
  private taskRepository: SqliteTaskRepository;
  private runRepository: SqliteRunRepository;
  private runEventRepository: SqliteRunEventRepository;
  private turnRepository: SqliteTurnRepository;
  private approvalRepository: SqliteApprovalRepository;
  private artifactRepository: SqliteArtifactRepository;
  private memoryRepository: SqliteMemoryRepository;
  private memoryService: MemoryService;

  constructor(store: DesktopStore) {
    this.store = store;
    const db = openStateDatabase(join(app.getPath("userData"), "shiguang-state.sqlite"));
    this.sessionRepository = new SqliteSessionRepository(db);
    this.taskRepository = new SqliteTaskRepository(db);
    this.runRepository = new SqliteRunRepository(db);
    this.runEventRepository = new SqliteRunEventRepository(db);
    this.turnRepository = new SqliteTurnRepository(db);
    this.approvalRepository = new SqliteApprovalRepository(db);
    this.artifactRepository = new SqliteArtifactRepository(db);
    this.memoryRepository = new SqliteMemoryRepository(db);
    this.memoryService = new MemoryService(this.memoryRepository);
  }

  addWindow(win: BrowserWindow): void {
    this.windows.add(win);
    win.on("closed", () => this.windows.delete(win));
  }

  listSessions(): DesktopSession[] {
    return this.store.listSessions();
  }

  async createSession(title?: string): Promise<DesktopSession> {
    const now = new Date().toISOString();
    const session: DesktopSession = {
      id: nextId("sess"),
      title: title || "New Session",
      status: "active",
      createdAt: now,
      updatedAt: now,
      summary: null,
    };
    const stored = this.store.createSession(session);
    await this.sessionRepository.create(desktopSessionToCore(stored));
    return stored;
  }

  async getSessionDetail(sessionId: string): Promise<DesktopSessionDetail> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.ensureSqliteSession(session);
    const runs = (await this.runRepository.listBySession(sessionId)).map(coreRunToDesktop);
    return { session, runs };
  }

  async sendUserMessage(sessionId: string, message: string): Promise<DesktopRun> {
    let session = this.store.getSession(sessionId);
    if (!session) {
      session = await this.createSession("Auto-created session");
      sessionId = session.id;
    }
    await this.ensureSqliteSession(session);

    const runId = nextId("run");
    const now = new Date();
    const task: Task = {
      id: `task_${runId}`,
      sessionId,
      parentTaskId: null,
      title: message.slice(0, 80) || "User message",
      description: null,
      status: "in_progress",
      priority: 0,
      createdAt: now,
      updatedAt: now,
    };
    const run: Run = {
      id: runId,
      sessionId,
      taskId: task.id,
      status: "pending",
      reason: null,
      startedAt: null,
      endedAt: null,
      model: null,
      summary: null,
    };
    await this.taskRepository.create(task);
    await this.runRepository.create(run);

    const sink = new RepositoryEventSink(this.runEventRepository);

    const { planner, label } = createPlanner();
    const workspaceRoot = resolve(normalize(process.env.SHIGUANG_WORKSPACE_ROOT ?? process.cwd()));
    const tools = [
      createReadTextFileTool(workspaceRoot),
      createWriteTextFileTool(workspaceRoot),
      createSearchWorkspaceTool(workspaceRoot),
      createRunValidationTool(workspaceRoot),
    ];
    const agent = new Agent({
      eventSink: sink,
      planner,
      tools,
      turnRepository: this.turnRepository,
      memoryService: this.memoryService,
      workspaceRoot,
    });

    (async () => {
      await this.runRepository.update(runId, {
        status: "running",
        startedAt: new Date(),
        model: label,
      });

      const userEvent = await sink.record(runId, "message", { role: "user", content: message });
      this.broadcastEvent(coreEventToDesktop(userEvent));

      try {
        const recentRuns = (await this.runRepository.listBySession(sessionId))
          .filter((recentRun) => recentRun.id !== runId);
        const linkedArtifacts = await this.loadLinkedArtifacts(sessionId, task.id);
        const pendingApprovals = await this.approvalRepository.listBySession(sessionId);
        const approvalContinuity = pendingApprovals.length > 0
          ? formatPendingApprovals(pendingApprovals)
          : undefined;
        const combinedInstructions = [approvalContinuity].filter(Boolean).join("\n\n");
        const output = await agent.run({
          runId,
          userMessage: message,
          contextInput: {
            task,
            recentRuns,
            linkedArtifacts,
            memories: [],
            workspaceRoot,
            systemInstructions: combinedInstructions || undefined,
          },
        });
        const storedEvents = await sink.list(runId);

        for (const evt of storedEvents) {
          if (evt.id !== userEvent.id) {
            this.broadcastEvent(coreEventToDesktop(evt));
          }
        }

        await this.persistApprovalsFromEvents(runId, storedEvents);

        const lastResult = output.state.lastResult;
        const stepsSummary = `${output.state.steps} step(s)`;
        const plannerLabel = `planner:${label}`;
        const contentBrief = lastResult
          ? (typeof lastResult.output === "string" ? lastResult.output.slice(0, 120) : JSON.stringify(lastResult.output).slice(0, 120))
          : "Completed";
        const summary = `[${plannerLabel}] ${stepsSummary} — ${contentBrief}`;
        await this.runRepository.update(runId, {
          status: "completed",
          endedAt: new Date(),
          summary,
        });
        await this.taskRepository.update(task.id, {
          status: "completed",
          updatedAt: new Date(),
        });
        await this.artifactRepository.create({
          id: `artifact_${runId}_summary`,
          sessionId,
          taskId: task.id,
          runId,
          kind: "run-summary",
          uri: `shiguang://runs/${runId}/summary`,
          title: summary,
          metadata: {
            summary,
            planner: label,
            steps: output.state.steps,
          },
          createdAt: new Date(),
        });
        await this.persistRunMemory({
          runId,
          task,
          workspaceRoot,
          kind: output.state.steps >= 2 ? "insight" : "observation",
          summary,
          content: buildCompletedMemoryContent({
            task,
            summary,
            steps: output.state.steps,
            lastResult,
            stopReason: output.state.stopReason,
          }),
          salience: output.state.steps >= 2 ? 0.72 : 0.58,
          confidence: 0.82,
        });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.runRepository.update(runId, {
          status: "failed",
          endedAt: new Date(),
          reason,
        });
        await this.taskRepository.update(task.id, {
          status: "failed",
          updatedAt: new Date(),
        });

        const errorEvent = await sink.record(runId, "error", { message: reason });
        this.broadcastEvent(coreEventToDesktop(errorEvent));
        await this.persistRunMemory({
          runId,
          task,
          workspaceRoot,
          kind: "decision",
          summary: `Run failed: ${task.title.slice(0, 80)}`,
          content: buildFailedMemoryContent({ task, reason }),
          salience: 0.9,
          confidence: 0.93,
        });
      }

      const sessionRuns = await this.runRepository.listBySession(sessionId);
      const completedCount = sessionRuns.filter((r) => r.status === "completed").length;
      const updatedAt = new Date();
      const summary = `${sessionRuns.length} run(s), ${completedCount} completed`;
      this.store.updateSession(sessionId, {
        updatedAt: updatedAt.toISOString(),
        summary,
      });
      await this.sessionRepository.update(sessionId, {
        updatedAt,
        summary,
      });
    })().catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      void this.runRepository.update(runId, {
        status: "failed",
        endedAt: new Date(),
        reason,
      });
      void this.taskRepository.update(task.id, {
        status: "failed",
        updatedAt: new Date(),
      });
      void sink.record(runId, "error", { message: reason }).then((event) => {
        this.broadcastEvent(coreEventToDesktop(event));
      });
      this.store.updateSession(sessionId, {
        updatedAt: new Date().toISOString(),
        summary: "Last run failed before completion",
      });
    });

    return coreRunToDesktop(run);
  }

  async getRunEvents(runId: string): Promise<DesktopEvent[]> {
    return (await this.runEventRepository.listByRun(runId)).map(coreEventToDesktop);
  }

  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void {
    const handler = (_event: unknown, data: DesktopEvent) => {
      if (data.runId === runId) {
        callback(data);
      }
    };

    for (const win of this.windows) {
      win.webContents.on("ipc-message", handler as unknown as (...args: unknown[]) => void);
    }

    return () => {};
  }

  private broadcastEvent(event: DesktopEvent): void {
    for (const win of this.windows) {
      if (!win.isDestroyed()) {
        win.webContents.send("run-event", event);
      }
    }
  }

  private async ensureSqliteSession(session: DesktopSession): Promise<void> {
    const existing = await this.sessionRepository.get(session.id);
    if (existing) return;
    await this.sessionRepository.create(desktopSessionToCore(session));
  }

  private async persistApprovalsFromEvents(runId: string, events: RunEvent[]): Promise<void> {
    for (const evt of events) {
      if (evt.kind !== "approval_request" && evt.kind !== "approval_granted" && evt.kind !== "approval_denied") continue;
      const payload = evt.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") continue;
      if (evt.kind === "approval_request") {
        const approval = makeApproval(runId, payload);
        if (approval) {
          await this.approvalRepository.create(approval);
        }
      } else {
        const approvalId = payload.approvalId as string | undefined;
        if (approvalId) {
          await this.approvalRepository.update(approvalId, {
            status: evt.kind === "approval_granted" ? "granted" : "denied",
            decidedAt: new Date(),
          });
        }
      }
    }
  }

  private async loadLinkedArtifacts(sessionId: string, taskId: string): Promise<Artifact[]> {
    const byId = new Map<string, Artifact>();

    for (const artifact of await this.artifactRepository.listByTask(taskId)) {
      byId.set(artifact.id, artifact);
    }

    for (const artifact of await this.artifactRepository.listBySession(sessionId)) {
      byId.set(artifact.id, artifact);
    }

    return [...byId.values()];
  }

  private async persistRunMemory(input: {
    runId: string;
    task: Task;
    workspaceRoot: string;
    kind: Memory["kind"];
    summary: string;
    content: string;
    salience: number;
    confidence: number;
  }): Promise<void> {
    if (!shouldPersistRunMemory(input.summary, input.content)) return;

    const now = new Date();
    await this.memoryService.save({
      id: nextId("mem"),
      scope: "workspace",
      workspaceScope: input.workspaceRoot,
      kind: input.kind,
      summary: input.summary,
      content: input.content,
      salience: input.salience,
      lastAccessedAt: null,
      sourceType: "run",
      sourceId: input.runId,
      confidence: input.confidence,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function shouldPersistRunMemory(summary: string, content: string): boolean {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim();
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  if (normalizedSummary.length < 12) return false;
  if (normalizedContent.length < 40) return false;
  if (/^\[planner:[^\]]+\]\s+\d+ step\(s\)\s+—\s+(Completed|Done)\.?$/i.test(normalizedSummary)) {
    return false;
  }
  return true;
}

function buildCompletedMemoryContent(input: {
  task: Task;
  summary: string;
  steps: number;
  lastResult: unknown;
  stopReason: string | null;
}): string {
  const parts = [
    `Task: ${input.task.title}`,
    "Outcome: completed",
    `Run summary: ${input.summary}`,
    `Steps: ${input.steps}`,
  ];

  if (input.stopReason) {
    parts.push(`Stop reason: ${input.stopReason}`);
  }

  const lastResultSummary = summarizeUnknownValue(input.lastResult, 500);
  if (lastResultSummary) {
    parts.push(`Last result: ${lastResultSummary}`);
  }

  return parts.join("\n");
}

function buildFailedMemoryContent(input: { task: Task; reason: string }): string {
  return [
    `Task: ${input.task.title}`,
    "Outcome: failed",
    `Failure reason: ${input.reason}`,
  ].join("\n");
}

function summarizeUnknownValue(value: unknown, maxLength = 500): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  }
  if (value === null || value === undefined) return "";
  const serialized = JSON.stringify(value);
  if (!serialized) return "";
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
}

function makeApproval(runId: string, payload: Record<string, unknown>): Approval | null {
  const { approvalId, pluginId, capability, request } = payload;
  if (typeof approvalId !== "string" && !approvalId) return null;
  return {
    id: approvalId as string || `appr_${runId}_${Date.now()}`,
    runId,
    pluginId: (pluginId as string) ?? "unknown",
    capability: (capability as string) ?? "unknown",
    status: "pending",
    request: request ?? {},
    decidedAt: null,
  };
}

function formatPendingApprovals(approvals: Approval[]): string {
  const lines = approvals.map(
    (a) =>
      `- approval[${a.id}] run[${a.runId}] plugin[${a.pluginId}] capability[${a.capability}] request: ${summarizeRequest(a.request)}`,
  );
  return `Pending approvals from prior runs:\n${lines.join("\n")}`;
}

function summarizeRequest(request: unknown): string {
  if (typeof request === "string") return request.slice(0, 200);
  if (request && typeof request === "object") {
    const str = JSON.stringify(request);
    return str.length > 200 ? str.slice(0, 200) + "..." : str;
  }
  return String(request).slice(0, 200);
}

function desktopSessionToCore(session: DesktopSession): Session {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    summary: session.summary,
  };
}

function coreRunToDesktop(run: Run): DesktopRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    reason: run.reason,
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    summary: run.summary,
  };
}

function coreEventToDesktop(event: RunEvent): DesktopEvent {
  return {
    id: event.id,
    runId: event.runId,
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

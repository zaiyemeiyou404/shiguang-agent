import { DesktopStore } from "./store.js";
import { app, BrowserWindow } from "electron";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSessionDetail, DesktopSettings, DesktopApproval } from "./types.js";
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
import { createPatchTextFileTool } from "../dist/tools/builtins/patch-text-file.js";
import { createRunTerminalCommandTool } from "../dist/tools/builtins/run-terminal-command.js";
import { createRunValidationTool } from "../dist/tools/builtins/run-validation.js";
import { createSearchWorkspaceTool } from "../dist/tools/builtins/search-workspace.js";
import { createListDirectoryTool } from "../dist/tools/builtins/list-directory.js";
import { createStatPathTool } from "../dist/tools/builtins/stat-path.js";
import { createCopyPathTool } from "../dist/tools/builtins/copy-path.js";
import { createMovePathTool } from "../dist/tools/builtins/move-path.js";
import { createDeletePathTool } from "../dist/tools/builtins/delete-path.js";
import { createPlanner } from "./planner-factory.js";
import { loadDesktopConfig, getDesktopSettings, saveDesktopSettings } from "./config.js";
import { join, resolve, normalize } from "node:path";

let seqCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seqCounter}`;
}

export class DesktopService {
  private store: DesktopStore;
  private windows: Set<BrowserWindow> = new Set();
  private activeRunControllers: Map<string, AbortController> = new Map();
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

  async listSessions(): Promise<DesktopSession[]> {
    const sessions = this.store.listSessions();
    return Promise.all(sessions.map((session) => this.decorateSession(session)));
  }

  getSettings(): DesktopSettings {
    return getDesktopSettings();
  }

  saveSettings(settings: DesktopSettings): DesktopSettings {
    return saveDesktopSettings(settings);
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
    return { session: await this.decorateSession(session), runs };
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
    const controller = new AbortController();
    this.activeRunControllers.set(runId, controller);

    const sink = new RepositoryEventSink(this.runEventRepository, (event) => {
      this.broadcastEvent(coreEventToDesktop(event));
    });

    const desktopConfig = loadDesktopConfig();
    const { planner, label } = createPlanner(desktopConfig.llm);
    const workspaceRoot = resolve(normalize(desktopConfig.workspaceRoot));
    const tools = [
      createListDirectoryTool(workspaceRoot),
      createStatPathTool(workspaceRoot),
      createReadTextFileTool(workspaceRoot),
      createSearchWorkspaceTool(workspaceRoot),
      createWriteTextFileTool(workspaceRoot),
      createPatchTextFileTool(workspaceRoot),
      createCopyPathTool(workspaceRoot),
      createMovePathTool(workspaceRoot),
      createDeletePathTool(workspaceRoot),
      createRunTerminalCommandTool(workspaceRoot),
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
      const currentRunBeforeStart = await this.runRepository.get(runId);
      if (controller.signal.aborted || currentRunBeforeStart?.status === "cancelled") {
        return;
      }

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
          signal: controller.signal,
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
        await this.persistApprovalsFromEvents(runId, storedEvents);

        const currentRun = await this.runRepository.get(runId);
        if (currentRun?.status === "cancelled") {
          return;
        }

        const lastResult = output.state.lastResult;
        const stepsSummary = `${output.state.steps} step(s)`;
        const plannerLabel = `planner:${label}`;
        const contentBrief = lastResult
          ? (typeof lastResult.output === "string" ? lastResult.output.slice(0, 120) : JSON.stringify(lastResult.output).slice(0, 120))
          : "Completed";
        const summary = `[${plannerLabel}] ${stepsSummary} — ${contentBrief}`;
        const runStatus = deriveRunStatus(output.state);
        const taskStatus = deriveTaskStatus(runStatus);
        await this.runRepository.update(runId, {
          status: runStatus,
          endedAt: new Date(),
          summary,
          reason: output.state.lastDecision?.action.reason ?? output.state.stopSummary ?? null,
        });
        await this.taskRepository.update(task.id, {
          status: taskStatus,
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
            runStatus,
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
        const currentRun = await this.runRepository.get(runId);
        if (currentRun?.status === "cancelled") {
          return;
        }
        await this.runRepository.update(runId, {
          status: "failed",
          endedAt: new Date(),
          reason,
        });
        await this.taskRepository.update(task.id, {
          status: "failed",
          updatedAt: new Date(),
        });

        await sink.record(runId, "error", { message: reason });
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
      } finally {
        this.activeRunControllers.delete(runId);
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
      void this.runRepository.get(runId).then((currentRun) => {
        if (currentRun?.status === "cancelled") {
          return;
        }
        void this.runRepository.update(runId, {
          status: "failed",
          endedAt: new Date(),
          reason,
        });
        void this.taskRepository.update(task.id, {
          status: "failed",
          updatedAt: new Date(),
        });
        void sink.record(runId, "error", { message: reason });
        this.store.updateSession(sessionId, {
          updatedAt: new Date().toISOString(),
          summary: "Last run failed before completion",
        });
      });
    });

    return coreRunToDesktop(run);
  }

  async getRunEvents(runId: string): Promise<DesktopEvent[]> {
    return (await this.runEventRepository.listByRun(runId)).map(coreEventToDesktop);
  }

  async listPendingApprovals(sessionId: string): Promise<DesktopApproval[]> {
    return (await this.approvalRepository.listBySession(sessionId)).map(coreApprovalToDesktop);
  }

  async decideApproval(approvalId: string, decision: "granted" | "denied"): Promise<DesktopApproval> {
    const approval = await this.approvalRepository.get(approvalId);
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    const decidedAt = new Date();
    await this.approvalRepository.update(approvalId, {
      status: decision,
      decidedAt,
    });

    if (decision === "granted") {
      await this.runRepository.update(approval.runId, {
        status: "running",
        endedAt: null,
        reason: null,
      });
      const grantedRun = await this.runRepository.get(approval.runId);
      if (grantedRun) {
        await this.taskRepository.update(grantedRun.taskId, {
          status: "in_progress",
          updatedAt: decidedAt,
        });
      }
    } else {
      await this.runRepository.update(approval.runId, {
        status: "failed",
        endedAt: decidedAt,
        reason: `Approval denied for capability: ${approval.capability}`,
      });
      const deniedRun = await this.runRepository.get(approval.runId);
      if (deniedRun) {
        await this.taskRepository.update(deniedRun.taskId, {
          status: "failed",
          updatedAt: decidedAt,
        });
      }
    }

    const sink = new RepositoryEventSink(this.runEventRepository, (event) => {
      this.broadcastEvent(coreEventToDesktop(event));
    });
    const event = await sink.record(
      approval.runId,
      decision === "granted" ? "approval_granted" : "approval_denied",
      {
        approvalId: approval.id,
        capability: approval.capability,
        request: approval.request,
      },
    );

    if (decision === "granted") {
      void this.resumeRunAfterApproval(approval);
    }

    return coreApprovalToDesktop({
      ...approval,
      status: decision,
      decidedAt,
    });
  }

  async cancelRun(runId: string): Promise<DesktopRun> {
    const run = await this.runRepository.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return coreRunToDesktop(run);
    }

    const now = new Date();
    this.activeRunControllers.get(runId)?.abort();
    await this.runRepository.update(runId, {
      status: "cancelled",
      endedAt: now,
      reason: "Cancelled by user.",
    });
    await this.taskRepository.update(run.taskId, {
      status: "cancelled",
      updatedAt: now,
    });

    const pendingApprovals = await this.approvalRepository.listPending(runId);
    for (const approval of pendingApprovals) {
      await this.approvalRepository.update(approval.id, {
        status: "expired",
        decidedAt: now,
      });
    }

    const sink = new RepositoryEventSink(this.runEventRepository, (event) => {
      this.broadcastEvent(coreEventToDesktop(event));
    });
    await sink.record(runId, "system", {
      message: run.status === "running" ? "run cancellation requested by user" : "run cancelled by user",
    });

    await this.refreshSessionSummary(run.sessionId);
    const updatedRun = await this.runRepository.get(runId);
    if (!updatedRun) {
      throw new Error(`Run not found after cancellation: ${runId}`);
    }
    return coreRunToDesktop(updatedRun);
  }

  async retryRun(runId: string): Promise<DesktopRun> {
    const run = await this.runRepository.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const task = await this.taskRepository.get(run.taskId);
    if (!task) {
      throw new Error(`Task not found for run: ${runId}`);
    }
    const userMessage = await this.loadLatestUserMessage(run.sessionId, task);
    return this.sendUserMessage(run.sessionId, userMessage);
  }

  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void {
    const handler = (_event: unknown, data: DesktopEvent) => {
      if (data.runId === runId) {
        callback(data);
      }
    };

    for (const win of Array.from(this.windows)) {
      win.webContents.on("ipc-message", handler as unknown as (...args: unknown[]) => void);
    }

    return () => {};
  }

  private broadcastEvent(event: DesktopEvent): void {
    for (const win of Array.from(this.windows)) {
      if (!win.isDestroyed()) {
        win.webContents.send("run-event", event);
      }
    }
  }

  private async decorateSession(session: DesktopSession): Promise<DesktopSession> {
    const runs = (await this.runRepository.listBySession(session.id)).map(coreRunToDesktop);
    const latestRun = runs[0] ?? null;
    const pendingApprovals = await this.approvalRepository.listBySession(session.id);
    const latestRunEvents = latestRun ? await this.runEventRepository.listByRun(latestRun.id) : [];

    return {
      ...session,
      attention: {
        latestRunStatus: latestRun?.status ?? null,
        hasRunningRun: runs.some((run) => run.status === "pending" || run.status === "running"),
        hasPendingApproval: pendingApprovals.length > 0,
        pendingApprovalCount: pendingApprovals.length,
        hasFailedRun: latestRun?.status === "failed",
        hasContextCompaction: latestRunEvents.some((event) => event.kind === "context_compacted"),
      },
    };
  }

  private createAgentRuntime(sink: RepositoryEventSink): {
    agent: Agent;
    label: string;
    workspaceRoot: string;
  } {
    const desktopConfig = loadDesktopConfig();
    const { planner, label } = createPlanner(desktopConfig.llm);
    const workspaceRoot = resolve(normalize(desktopConfig.workspaceRoot));
    const tools = [
      createListDirectoryTool(workspaceRoot),
      createStatPathTool(workspaceRoot),
      createReadTextFileTool(workspaceRoot),
      createSearchWorkspaceTool(workspaceRoot),
      createWriteTextFileTool(workspaceRoot),
      createPatchTextFileTool(workspaceRoot),
      createCopyPathTool(workspaceRoot),
      createMovePathTool(workspaceRoot),
      createDeletePathTool(workspaceRoot),
      createRunTerminalCommandTool(workspaceRoot),
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

    return { agent, label, workspaceRoot };
  }

  private async loadLatestUserMessage(sessionId: string, task: Task): Promise<string> {
    const turns = await this.turnRepository.listBySession(sessionId, 50);
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]?.role === "user" && turns[i]?.content.trim()) {
        return turns[i]!.content;
      }
    }
    return task.description?.trim() || task.title;
  }

  private async resumeRunAfterApproval(approval: Approval): Promise<void> {
    const run = await this.runRepository.get(approval.runId);
    if (!run) return;
    const task = await this.taskRepository.get(run.taskId);
    if (!task) return;

    const approvedAction = extractApprovedToolAction(approval);
    if (!approvedAction) {
      const reason = `Approval ${approval.id} is missing a resumable tool request.`;
      await this.runRepository.update(run.id, {
        status: "failed",
        endedAt: new Date(),
        reason,
      });
      await this.taskRepository.update(task.id, {
        status: "failed",
        updatedAt: new Date(),
      });
      return;
    }

    const sink = new RepositoryEventSink(this.runEventRepository, (event) => {
      this.broadcastEvent(coreEventToDesktop(event));
    });
    const { agent, label, workspaceRoot } = this.createAgentRuntime(sink);
    const userMessage = await this.loadLatestUserMessage(run.sessionId, task);
    const controller = new AbortController();
    this.activeRunControllers.set(run.id, controller);

    try {
      const recentRuns = (await this.runRepository.listBySession(run.sessionId))
        .filter((recentRun) => recentRun.id !== run.id);
      const linkedArtifacts = await this.loadLinkedArtifacts(run.sessionId, task.id);
      const pendingApprovals = await this.approvalRepository.listBySession(run.sessionId);
      const approvalContinuity = pendingApprovals.length > 0
        ? formatPendingApprovals(pendingApprovals)
        : undefined;
      const combinedInstructions = [approvalContinuity].filter(Boolean).join("\n\n");

      const output = await agent.resumeAfterApproval({
        runId: run.id,
        userMessage,
        signal: controller.signal,
        approvedAction,
        contextInput: {
          task,
          recentRuns,
          linkedArtifacts,
          memories: [],
          workspaceRoot,
          systemInstructions: combinedInstructions || undefined,
        },
      });

      const storedEvents = await sink.list(run.id);
      await this.persistApprovalsFromEvents(run.id, storedEvents);

      const currentRun = await this.runRepository.get(run.id);
      if (currentRun?.status === "cancelled") {
        return;
      }

      const lastResult = output.state.lastResult;
      const stepsSummary = `${output.state.steps} step(s)`;
      const plannerLabel = `planner:${label}`;
      const contentBrief = lastResult
        ? (typeof lastResult.output === "string" ? lastResult.output.slice(0, 120) : JSON.stringify(lastResult.output).slice(0, 120))
        : "Completed";
      const summary = `[${plannerLabel}] ${stepsSummary} — ${contentBrief}`;
      const runStatus = deriveRunStatus(output.state);
      const taskStatus = deriveTaskStatus(runStatus);
      await this.runRepository.update(run.id, {
        status: runStatus,
        endedAt: new Date(),
        summary,
        reason: output.state.lastDecision?.action.reason ?? output.state.stopSummary ?? null,
      });
      await this.taskRepository.update(task.id, {
        status: taskStatus,
        updatedAt: new Date(),
      });
      await this.artifactRepository.create({
        id: `artifact_${run.id}_summary_resume_${Date.now()}`,
        sessionId: run.sessionId,
        taskId: task.id,
        runId: run.id,
        kind: "run-summary",
        uri: `shiguang://runs/${run.id}/summary/resume`,
        title: summary,
        metadata: {
          summary,
          planner: label,
          steps: output.state.steps,
          resumedFromApproval: approval.id,
        },
        createdAt: new Date(),
      });
      await this.persistRunMemory({
        runId: run.id,
        task,
        workspaceRoot,
        kind: output.state.steps >= 2 ? "insight" : "observation",
        summary,
        content: buildCompletedMemoryContent({
          task,
          runStatus,
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
      const currentRun = await this.runRepository.get(run.id);
      if (currentRun?.status === "cancelled") {
        return;
      }
      await this.runRepository.update(run.id, {
        status: "failed",
        endedAt: new Date(),
        reason,
      });
      await this.taskRepository.update(task.id, {
        status: "failed",
        updatedAt: new Date(),
      });

      await sink.record(run.id, "error", { message: reason });
      await this.persistRunMemory({
        runId: run.id,
        task,
        workspaceRoot,
        kind: "decision",
        summary: `Run failed: ${task.title.slice(0, 80)}`,
        content: buildFailedMemoryContent({ task, reason }),
        salience: 0.9,
        confidence: 0.93,
      });
    } finally {
      this.activeRunControllers.delete(run.id);
    }

    await this.refreshSessionSummary(run.sessionId);
  }

  private async refreshSessionSummary(sessionId: string): Promise<void> {
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

    return Array.from(byId.values());
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
    if (!shouldPersistRunMemory(input.kind, input.summary, input.content)) return;

    const duplicate = await this.findDuplicateRunMemory(input);
    if (duplicate) {
      await this.memoryRepository.update(duplicate.id, {
        kind: input.kind,
        summary: input.summary,
        content: input.content,
        salience: Math.max(duplicate.salience, input.salience),
        sourceType: "run",
        sourceId: input.runId,
        confidence: Math.max(duplicate.confidence, input.confidence),
      });
      return;
    }

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

  private async findDuplicateRunMemory(input: {
    workspaceRoot: string;
    kind: Memory["kind"];
    summary: string;
    content: string;
  }): Promise<Memory | null> {
    const existing = await this.memoryRepository.listByWorkspace(input.workspaceRoot, 100);
    const targetFingerprint = memoryFingerprint(input.kind, input.summary, input.content);
    return existing.find((memory) => memoryFingerprint(memory.kind, memory.summary, memory.content) === targetFingerprint) ?? null;
  }
}

function shouldPersistRunMemory(kind: Memory["kind"], summary: string, content: string): boolean {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim();
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  if (normalizedSummary.length < 12) return false;
  if (normalizedContent.length < 40) return false;
  if (/^\[planner:[^\]]+\]\s+\d+ step\(s\)\s+—\s+(Completed|Done)\.?$/i.test(normalizedSummary)) {
    return false;
  }
  if (kind === "decision" && !isHighValueFailure(normalizedContent)) {
    return false;
  }
  return true;
}

function isHighValueFailure(content: string): boolean {
  if (content.length < 80) return false;
  if (/(^|\s)failure reason:\s*(unknown error|aborted|cancelled|interrupted|failed)\.?$/i.test(content)) {
    return false;
  }
  return /(validation|test|assert|typecheck|type check|eslint|lint|compile|compiler|syntax|import|module|cannot find|not found|timeout|permission|exception|traceback|stack trace|ts\d+)/i.test(content);
}

function memoryFingerprint(kind: Memory["kind"], summary: string, content: string): string {
  return [kind, normalizeMemoryText(summary), normalizeMemoryText(content)].join("|");
}

function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:run|task|mem)_\d+_\d+\b/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCompletedMemoryContent(input: {
  task: Task;
  runStatus: Run["status"];
  summary: string;
  steps: number;
  lastResult: unknown;
  stopReason: string | null;
}): string {
  const parts = [
    `Task: ${input.task.title}`,
    `Outcome: ${input.runStatus}`,
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

function deriveRunStatus(state: { stopReason: string | null; lastDecision: { action: { kind: string } } | null }): Run["status"] {
  if (state.lastDecision?.action.kind === "needs_approval" || state.stopReason === "needs_approval") {
    return "needs_approval";
  }
  if (state.lastDecision?.action.kind === "fail" || state.stopReason === "fail" || state.stopReason === "non_retryable_tool_error" || state.stopReason === "repeated_retryable_tool_error") {
    return "failed";
  }
  return "completed";
}

function deriveTaskStatus(runStatus: Run["status"]): Task["status"] {
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed") return "failed";
  return "in_progress";
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

function extractApprovedToolAction(approval: Approval): { toolName: string; toolInput?: unknown } | null {
  const request = approval.request;
  if (!request || typeof request !== "object") return null;

  const toolName = typeof (request as { toolName?: unknown }).toolName === "string"
    ? (request as { toolName: string }).toolName
    : null;
  if (!toolName) return null;

  return {
    toolName,
    toolInput: (request as { toolInput?: unknown }).toolInput,
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

function coreApprovalToDesktop(approval: Approval): DesktopApproval {
  return {
    id: approval.id,
    runId: approval.runId,
    pluginId: approval.pluginId,
    capability: approval.capability,
    status: approval.status,
    request: approval.request,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
  };
}

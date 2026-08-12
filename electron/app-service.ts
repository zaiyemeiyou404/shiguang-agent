import { DesktopStore } from "./store.js";
import { app, dialog, shell } from "electron";
import type {
  DesktopSession,
  DesktopRun,
  DesktopTurn,
  DesktopConversationEntry,
  DesktopEvent,
  DesktopSessionDetail,
  DesktopWorkspaceSnapshot,
  DesktopSettings,
  DesktopApproval,
  DesktopArtifact,
  DesktopProviderConnectionRequest,
  DesktopProviderConnectionResult,
  DesktopProviderSettings,
  DesktopAttachment,
  DesktopSessionBranchResult,
} from "./types.js";
import { Agent } from "../dist/app/agent.js";
import { RepositoryEventSink } from "../dist/runtime/event-sink.js";
import type { Approval, Artifact, Memory, Run, RunEvent, Session, Task, Turn } from "../dist/core/types.js";
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
import { createGitStatusTool } from "../dist/tools/builtins/git-status.js";
import { createGitDiffTool } from "../dist/tools/builtins/git-diff.js";
import { createInspectProjectTool } from "../dist/tools/builtins/inspect-project.js";
import { createGitHubRepoTool } from "../dist/tools/builtins/github-repo.js";
import { createWebFetchTool } from "../dist/tools/builtins/web-fetch.js";
import { createWebSearchTool } from "../dist/tools/builtins/web-search.js";
import { createCollectDiagnosticsTool } from "../dist/tools/builtins/collect-diagnostics.js";
import {
  createStartBackgroundProcessTool,
  createListBackgroundProcessesTool,
  createReadBackgroundProcessTool,
  createStopBackgroundProcessTool,
} from "../dist/tools/builtins/background-processes.js";
import {
  createSearchMemoryTool,
  createRememberFactTool,
  createForgetMemoryTool,
} from "../dist/tools/builtins/memory-tools.js";
import {
  createCodeMapTool,
  createSymbolSearchTool,
  createDependencyGraphTool,
} from "../dist/tools/builtins/code-intelligence.js";
import type { Tool } from "../dist/tools/types.js";
import {
  McpStdioToolRuntime,
  type McpStdioServerConfig,
} from "../dist/tools/mcp-stdio-runtime.js";
import { createPlanner } from "./planner-factory.js";
import {
  loadDesktopConfig,
  getDesktopSettings,
  saveDesktopSettings,
  getStoredProviderApiKey,
  type ResolvedDesktopConfig,
  type ResolvedMcpServerConfig,
  type ToolApprovalMode,
} from "./config.js";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

let seqCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seqCounter}`;
}

function approvalAllowlistForMode(mode: ToolApprovalMode): string[] {
  const allowed = ["run_validation"];
  if (mode === "workspace_edits") {
    allowed.push("write_text_file", "patch_text_file");
  }
  return allowed;
}

export class DesktopAppService {
  private store: DesktopStore;
  private listeners: Set<(event: DesktopEvent) => void> = new Set();
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
  private mcpRuntime: McpStdioToolRuntime | null = null;
  private mcpRuntimeKey = "";

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

  async testProviderConnection(req: DesktopProviderConnectionRequest): Promise<DesktopProviderConnectionResult> {
    return testDesktopProviderConnection(req);
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

  async branchSessionFromRun(runId: string, title?: string): Promise<DesktopSessionBranchResult> {
    const run = await this.runRepository.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const sourceSession = this.store.getSession(run.sessionId);
    if (!sourceSession) {
      throw new Error(`Session not found for run: ${runId}`);
    }
    const task = await this.taskRepository.get(run.taskId);
    if (!task) {
      throw new Error(`Task not found for run: ${runId}`);
    }
    await this.ensureSqliteSession(sourceSession);
    const sourceRun = coreRunToDesktop(run);
    const branchTitle = title?.trim() || `${sourceSession.title} · 分支`;
    const branched = await this.createSession(branchTitle);
    const summary = `分支自 ${sourceSession.title} · ${branchStatusLabel(sourceRun.status)}`;
    const updatedAt = new Date().toISOString();
    const branchSession = this.store.updateSession(branched.id, { summary, updatedAt }) ?? branched;
    await this.ensureSqliteSession(branchSession);
    await this.sessionRepository.update(branchSession.id, { summary, updatedAt: new Date(updatedAt) });

    const sourceArtifacts = (await this.listArtifacts(sourceSession.id, run.id)).slice(0, 6);
    const latestUserMessage = await this.loadLatestUserMessage(run.sessionId, task);
    const suggestedPrompt = buildBranchSuggestedPrompt({
      sourceSession,
      sourceRun,
      latestUserMessage,
      artifacts: sourceArtifacts,
    });

    return {
      session: await this.decorateSession(branchSession),
      sourceSession: await this.decorateSession(sourceSession),
      sourceRun,
      suggestedPrompt,
    };
  }

  async renameSession(sessionId: string, title: string): Promise<DesktopSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Session title cannot be empty.");
    const updatedAt = new Date().toISOString();
    const updated = this.store.updateSession(sessionId, { title: trimmed, updatedAt });
    if (!updated) throw new Error(`Session not found: ${sessionId}`);
    await this.ensureSqliteSession(updated);
    await this.sessionRepository.update(sessionId, { title: trimmed, updatedAt: new Date(updatedAt) });
    return this.decorateSession(updated);
  }

  async updateSessionStatus(sessionId: string, status: DesktopSession["status"]): Promise<DesktopSession> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const updatedAt = new Date().toISOString();
    const updated = this.store.updateSession(sessionId, { status, updatedAt });
    if (!updated) throw new Error(`Session not found: ${sessionId}`);
    await this.ensureSqliteSession(updated);
    await this.sessionRepository.update(sessionId, { status, updatedAt: new Date(updatedAt) });
    return this.decorateSession(updated);
  }

  async deleteSession(sessionId: string): Promise<{ sessionId: string }> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const runs = await this.runRepository.listBySession(sessionId);
    const hasLiveRun = runs.some((run) => run.status === "pending" || run.status === "running" || run.status === "needs_approval");
    if (hasLiveRun) {
      throw new Error("Session still has a live run. Cancel or finish it before deleting.");
    }
    await this.ensureSqliteSession(session);
    await this.sessionRepository.update(sessionId, { status: "archived", updatedAt: new Date() });
    const deleted = this.store.deleteSession(sessionId);
    if (!deleted) throw new Error(`Session not found: ${sessionId}`);
    return { sessionId };
  }

  async getSessionDetail(sessionId: string): Promise<DesktopSessionDetail> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.ensureSqliteSession(session);
    const [runs, turns] = await Promise.all([
      this.runRepository.listBySession(sessionId),
      this.turnRepository.listBySession(sessionId, 200),
    ]);
    const conversation = await this.buildSessionConversation(sessionId, turns, runs);
    return {
      session: await this.decorateSession(session),
      runs: runs.map(coreRunToDesktop),
      turns: turns.map(coreTurnToDesktop),
      conversation,
    };
  }

  async getWorkspaceSnapshot(sessionId: string): Promise<DesktopWorkspaceSnapshot> {
    const detail = await this.getSessionDetail(sessionId);
    const [pendingApprovals, artifacts] = await Promise.all([
      this.listPendingApprovals(sessionId),
      this.listArtifacts(sessionId),
    ]);
    return { detail, pendingApprovals, artifacts };
  }

  async listArtifacts(sessionId: string, runId?: string): Promise<DesktopArtifact[]> {
    const artifacts = (await this.artifactRepository.listBySession(sessionId)).map(coreArtifactToDesktop);
    return runId ? artifacts.filter((artifact) => artifact.runId === runId) : artifacts;
  }

  async pickAttachments(): Promise<DesktopAttachment[]> {
    const result = await dialog.showOpenDialog({
      title: "选择要附加的文件",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths.map((filePath) => desktopAttachmentFromPath(filePath));
  }

  async openArtifact(uri: string): Promise<{ uri: string; targetPath: string }> {
    const targetPath = resolveLocalArtifactPath(uri);
    if (!targetPath) {
      throw new Error("当前只支持直接打开本地文件产物。HTTP 链接请使用网页打开。");
    }
    assertArtifactPathExists(targetPath);
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return { uri, targetPath };
  }

  async revealArtifact(uri: string): Promise<{ uri: string; targetPath: string }> {
    const targetPath = resolveLocalArtifactPath(uri);
    if (!targetPath) {
      throw new Error("当前只支持显示本地文件产物的位置。");
    }
    const stats = assertArtifactPathExists(targetPath);
    if (stats.isDirectory()) {
      const error = await shell.openPath(targetPath);
      if (error) throw new Error(error);
    } else {
      shell.showItemInFolder(targetPath);
    }
    return { uri, targetPath };
  }

  async sendUserMessage(sessionId: string, message: string, attachments: DesktopAttachment[] = []): Promise<DesktopRun> {
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

    const sink = this.createRunEventSink();
    const workspaceCommandTarget = parseWorkspaceRootCommand(message);
    if (workspaceCommandTarget) {
      void this.handleWorkspaceRootCommand({
        sessionId,
        task,
        runId,
        message,
        targetPath: workspaceCommandTarget,
        sink,
      });
      return coreRunToDesktop(run);
    }

    (async () => {
      const { agent, label, workspaceRoot } = await this.createAgentRuntime(sink);
      const currentRunBeforeStart = await this.runRepository.get(runId);
      if (controller.signal.aborted || currentRunBeforeStart?.status === "cancelled") {
        return;
      }

      await this.runRepository.update(runId, {
        status: "running",
        startedAt: new Date(),
        model: label,
      });

      await this.persistAttachmentArtifacts(sessionId, task.id, runId, attachments);
      await sink.record(runId, "message", { role: "user", content: message, attachments });

      try {
        const recentRuns = (await this.runRepository.listBySession(sessionId))
          .filter((recentRun) => recentRun.id !== runId);
        const linkedArtifacts = await this.loadLinkedArtifacts(sessionId, task.id);
        const pendingApprovals = await this.approvalRepository.listBySession(sessionId);
        const approvalContinuity = pendingApprovals.length > 0
          ? formatPendingApprovals(pendingApprovals)
          : undefined;
        const attachmentPrompt = formatAttachmentPrompt(attachments);
        const combinedInstructions = [approvalContinuity].filter(Boolean).join("\n\n");
        const output = await agent.run({
          runId,
          userMessage: buildUserMessageWithAttachments(message, attachments),
          signal: controller.signal,
          contextInput: {
            task,
            recentRuns,
            linkedArtifacts,
            memories: [],
            workspaceRoot,
            systemInstructions: [combinedInstructions, attachmentPrompt].filter(Boolean).join("\n\n") || undefined,
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
    await this.syncApprovalsForSession(sessionId);
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

    const sink = this.createRunEventSink();
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

    const sink = this.createRunEventSink();
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
    const listener = (event: DesktopEvent) => {
      if (event.runId === runId) {
        callback(event);
      }
    };

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcastEvent(event: DesktopEvent): void {
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  private createRunEventSink(): RepositoryEventSink {
    return new RepositoryEventSink(this.runEventRepository, async (event) => {
      await this.persistApprovalsFromEvents(event.runId, [event]);
      this.broadcastEvent(coreEventToDesktop(event));
    });
  }

  private async decorateSession(session: DesktopSession): Promise<DesktopSession> {
    await this.syncApprovalsForSession(session.id);
    const runs = (await this.runRepository.listBySession(session.id)).map(coreRunToDesktop);
    const latestRun = runs[0] ?? null;
    const pendingApprovals = await this.approvalRepository.listBySession(session.id);
    const latestRunEvents = latestRun ? await this.runEventRepository.listByRun(latestRun.id) : [];

    return {
      ...session,
      attention: {
        latestRunStatus: latestRun?.status ?? null,
        hasRunningRun: runs.some((run) => run.status === "pending" || run.status === "running" || run.status === "paused"),
        hasPendingApproval: pendingApprovals.length > 0,
        pendingApprovalCount: pendingApprovals.length,
        hasFailedRun: latestRun?.status === "failed",
        hasContextCompaction: latestRunEvents.some(isMeaningfulContextCompactionEvent),
      },
    };
  }

  private async createAgentRuntime(sink: RepositoryEventSink): Promise<{
    agent: Agent;
    label: string;
    workspaceRoot: string;
  }> {
    const desktopConfig = loadDesktopConfig();
    const { planner, label } = createPlanner(desktopConfig.llm);
    const workspaceRoot = resolve(normalize(desktopConfig.workspaceRoot));
    const tools = await this.createDesktopTools(desktopConfig, workspaceRoot);
    const agent = new Agent({
      eventSink: sink,
      planner,
      tools,
      allowToolsWithoutApproval: approvalAllowlistForMode(desktopConfig.toolApprovalMode),
      turnRepository: this.turnRepository,
      memoryService: this.memoryService,
      workspaceRoot,
    });

    return { agent, label, workspaceRoot };
  }

  private async createDesktopTools(desktopConfig: ResolvedDesktopConfig, workspaceRoot: string): Promise<Tool[]> {
    return [
      ...this.createBuiltinDesktopTools(workspaceRoot),
      ...await this.discoverMcpTools(desktopConfig.mcpServers),
    ];
  }

  private createBuiltinDesktopTools(workspaceRoot: string): Tool[] {
    return [
      createListDirectoryTool(workspaceRoot),
      createStatPathTool(workspaceRoot),
      createInspectProjectTool(workspaceRoot),
      createGitStatusTool(workspaceRoot),
      createGitDiffTool(workspaceRoot),
      createGitHubRepoTool(workspaceRoot),
      createWebFetchTool(),
      createWebSearchTool(),
      createCollectDiagnosticsTool(workspaceRoot),
      createCodeMapTool(workspaceRoot),
      createSymbolSearchTool(workspaceRoot),
      createDependencyGraphTool(workspaceRoot),
      createListBackgroundProcessesTool(),
      createReadBackgroundProcessTool(),
      createReadTextFileTool(workspaceRoot),
      createSearchWorkspaceTool(workspaceRoot),
      createSearchMemoryTool(this.memoryService, workspaceRoot),
      createRememberFactTool(this.memoryService, workspaceRoot),
      createWriteTextFileTool(workspaceRoot),
      createPatchTextFileTool(workspaceRoot),
      createCopyPathTool(workspaceRoot),
      createMovePathTool(workspaceRoot),
      createDeletePathTool(workspaceRoot),
      createRunTerminalCommandTool(workspaceRoot),
      createStartBackgroundProcessTool(workspaceRoot),
      createStopBackgroundProcessTool(),
      createForgetMemoryTool(this.memoryService),
      createRunValidationTool(workspaceRoot),
    ];
  }

  private async discoverMcpTools(configs: ResolvedMcpServerConfig[]): Promise<Tool[]> {
    if (configs.length === 0) return [];
    const runtime = this.getMcpRuntime(configs);
    return runtime.discoverTools();
  }

  private getMcpRuntime(configs: ResolvedMcpServerConfig[]): McpStdioToolRuntime {
    const key = JSON.stringify(configs.map((config) => ({
      id: config.id,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      disabled: config.disabled,
    })));
    if (this.mcpRuntime && this.mcpRuntimeKey === key) {
      return this.mcpRuntime;
    }

    if (this.mcpRuntime) {
      void this.mcpRuntime.closeAll();
    }

    const stdioConfigs: McpStdioServerConfig[] = configs.map((config) => ({
      id: config.id,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      disabled: config.disabled,
    }));
    this.mcpRuntime = new McpStdioToolRuntime(stdioConfigs, {
      clientInfo: { name: "shiguang-agent", version: "0.2.1" },
      logger: (message) => console.warn(message),
    });
    this.mcpRuntimeKey = key;
    return this.mcpRuntime;
  }

  private async handleWorkspaceRootCommand(input: {
    sessionId: string;
    task: Task;
    runId: string;
    message: string;
    targetPath: string;
    sink: RepositoryEventSink;
  }): Promise<void> {
    const startedAt = new Date();
    const model = "desktop:workspace";
    await this.runRepository.update(input.runId, {
      status: "running",
      startedAt,
      model,
    });
    await input.sink.record(input.runId, "message", { role: "user", content: input.message, attachments: [] });
    await this.turnRepository.create({
      id: nextId("turn"),
      sessionId: input.sessionId,
      role: "user",
      content: input.message,
      createdAt: startedAt,
    });

    try {
      const workspaceRoot = resolve(normalize(input.targetPath));
      assertUsableWorkspaceRoot(workspaceRoot);
      const currentSettings = getDesktopSettings();
      saveDesktopSettings({
        ...currentSettings,
        workspaceRoot,
      });

      const completedAt = new Date();
      const assistantMessage = [
        `工作区已切换到：${workspaceRoot}`,
        "后续新运行会在这个目录里调用 read/search/write/validation 工具。",
      ].join("\n");
      await input.sink.record(input.runId, "message", { role: "assistant", content: assistantMessage });
      await this.turnRepository.create({
        id: nextId("turn"),
        sessionId: input.sessionId,
        role: "assistant",
        content: assistantMessage,
        createdAt: completedAt,
      });
      await this.runRepository.update(input.runId, {
        status: "completed",
        endedAt: completedAt,
        summary: `Workspace switched to ${workspaceRoot}`,
        reason: null,
      });
      await this.taskRepository.update(input.task.id, {
        status: "completed",
        updatedAt: completedAt,
      });
      await this.persistRunMemory({
        runId: input.runId,
        task: input.task,
        workspaceRoot,
        kind: "preference",
        summary: `Workspace root set to ${workspaceRoot}`,
        content: assistantMessage,
        salience: 0.76,
        confidence: 0.95,
      });
    } catch (error) {
      const failedAt = new Date();
      const reason = error instanceof Error ? error.message : String(error);
      await input.sink.record(input.runId, "error", { message: reason });
      await this.turnRepository.create({
        id: nextId("turn"),
        sessionId: input.sessionId,
        role: "assistant",
        content: `工作区切换失败：${reason}`,
        createdAt: failedAt,
      });
      await this.runRepository.update(input.runId, {
        status: "failed",
        endedAt: failedAt,
        reason,
      });
      await this.taskRepository.update(input.task.id, {
        status: "failed",
        updatedAt: failedAt,
      });
    } finally {
      this.activeRunControllers.delete(input.runId);
      await this.refreshSessionSummary(input.sessionId);
    }
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

  private async buildSessionConversation(
    sessionId: string,
    turns: Turn[],
    runs: Run[],
  ): Promise<DesktopConversationEntry[]> {
    const turnEntries = turns
      .map(coreTurnToConversationEntry)
      .filter((entry): entry is DesktopConversationEntry => entry !== null);
    const eventEntryLists = await Promise.all(runs.map(async (run) => {
      const events = await this.runEventRepository.listByRun(run.id);
      return events
        .map((event) => coreEventToConversationEntry(sessionId, event))
        .filter((entry): entry is DesktopConversationEntry => entry !== null);
    }));

    return [...turnEntries, ...eventEntryLists.flat()]
      .sort(compareConversationEntries);
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

    const sink = this.createRunEventSink();
    const { agent, label, workspaceRoot } = await this.createAgentRuntime(sink);
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

  private async syncApprovalsForSession(sessionId: string): Promise<void> {
    const runs = await this.runRepository.listBySession(sessionId);
    for (const run of runs) {
      const events = await this.runEventRepository.listByRun(run.id);
      await this.persistApprovalsFromEvents(run.id, events);
    }
  }

  private async persistApprovalsFromEvents(runId: string, events: RunEvent[]): Promise<void> {
    for (const evt of events) {
      if (evt.kind !== "approval_request" && evt.kind !== "approval_granted" && evt.kind !== "approval_denied") continue;
      const payload = evt.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") continue;
      if (evt.kind === "approval_request") {
        const approval = makeApproval(runId, payload);
        if (approval) {
          const existing = await this.approvalRepository.get(approval.id);
          if (!existing) {
            await this.approvalRepository.create(approval);
          }
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

  private async persistAttachmentArtifacts(sessionId: string, taskId: string, runId: string, attachments: DesktopAttachment[]): Promise<void> {
    for (const attachment of attachments) {
      await this.artifactRepository.create({
        id: nextId("artifact"),
        sessionId,
        taskId,
        runId,
        kind: "user-attachment",
        uri: attachment.uri,
        title: attachment.name,
        metadata: {
          name: attachment.name,
          path: attachment.path,
          size: attachment.size,
          source: "composer-attachment",
        },
        createdAt: new Date(),
      });
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
  if (state.stopReason === "step_limit") {
    return "paused";
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

function parseWorkspaceRootCommand(message: string): string | null {
  const text = message.trim();
  if (!text) return null;

  const patterns = [
    /^(?:请)?(?:把|将)?(?:当前)?(?:工作区|工作目录|workspace)(?:路径)?(?:改到|改为|改成|切到|切换到|设置到|设置为|设为|换到|换成)\s*[:：]?\s*(.+)$/i,
    /^(?:请)?(?:切换|更换|设置|修改)(?:当前)?(?:工作区|工作目录|workspace)(?:到|为|成)\s*[:：]?\s*(.+)$/i,
    /^(?:workspace|cwd)\s*[:=]\s*(.+)$/i,
  ];

  for (const pattern of patterns) {
    const candidate = cleanWorkspacePathCandidate(pattern.exec(text)?.[1]);
    if (candidate && looksLikeWorkspacePath(candidate)) {
      return candidate;
    }
  }

  return null;
}

function cleanWorkspacePathCandidate(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
  value = value.replace(/^<(.+)>$/, "$1").trim();
  value = value.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  value = value.replace(/[。；;，,]+$/g, "").trim();
  return value || null;
}

function looksLikeWorkspacePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^[/~.][^/\\]*/.test(value);
}

function assertUsableWorkspaceRoot(workspaceRoot: string): void {
  if (!existsSync(workspaceRoot)) {
    throw new Error(`工作区路径不存在：${workspaceRoot}`);
  }
  const stats = statSync(workspaceRoot);
  if (!stats.isDirectory()) {
    throw new Error(`工作区路径不是目录：${workspaceRoot}`);
  }
}

async function testDesktopProviderConnection(req: DesktopProviderConnectionRequest): Promise<DesktopProviderConnectionResult> {
  const providerType = normalizeProviderType(req.provider.type);
  const authSource = resolveProviderAuthSource(req.provider);
  const startedAt = Date.now();
  const apiKey = resolveProviderApiKey(req.provider, req.providerKey);

  if (req.provider.authMode !== "none" && !apiKey) {
    return {
      ok: false,
      providerKey: req.providerKey,
      providerType,
      authSource,
      checkedAt: new Date().toISOString(),
      detail: `缺少 API Key：请填写 API Key，或提供可读取的环境变量 ${req.provider.apiKeyEnv ?? "(未设置)"}。`,
    };
  }

  try {
    await pingProvider({
      providerType,
      provider: req.provider,
      apiKey,
    });
    return {
      ok: true,
      providerKey: req.providerKey,
      providerType,
      authSource,
      checkedAt: new Date().toISOString(),
      detail: `连接成功（${Date.now() - startedAt}ms） · ${formatAuthSourceLabel(authSource)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      providerKey: req.providerKey,
      providerType,
      authSource,
      checkedAt: new Date().toISOString(),
      detail: `连接失败：${message}`,
    };
  }
}

function normalizeProviderType(value: DesktopProviderSettings["type"]): DesktopProviderConnectionResult["providerType"] {
  if (value === "anthropic" || value === "gemini" || value === "openai-compatible") {
    return value;
  }
  return "openai-compatible";
}

function resolveProviderAuthSource(provider: DesktopProviderSettings): DesktopProviderConnectionResult["authSource"] {
  if (provider.authMode === "none") return "none";
  if (provider.apiKey?.trim()) return "direct";
  if (provider.hasStoredApiKey) return "direct";
  if (provider.apiKeyEnv?.trim() && process.env[provider.apiKeyEnv.trim()]) return "env";
  return "missing";
}

function resolveProviderApiKey(provider: DesktopProviderSettings, providerKey: string): string {
  if (provider.authMode === "none") {
    return provider.apiKey?.trim() || "ollama";
  }
  if (provider.apiKey?.trim()) {
    return provider.apiKey.trim();
  }
  if (provider.hasStoredApiKey) {
    const storedApiKey = getStoredProviderApiKey(providerKey);
    if (storedApiKey) return storedApiKey;
  }
  if (provider.apiKeyEnv?.trim()) {
    return process.env[provider.apiKeyEnv.trim()]?.trim() ?? "";
  }
  return "";
}

function formatAuthSourceLabel(source: DesktopProviderConnectionResult["authSource"]): string {
  if (source === "direct") return "使用当前面板里的 API Key";
  if (source === "env") return "使用环境变量里的 API Key";
  if (source === "none") return "当前 provider 不需要 API Key";
  return "未解析到 API Key";
}

async function pingProvider(input: {
  providerType: DesktopProviderConnectionResult["providerType"];
  provider: DesktopProviderSettings;
  apiKey: string;
}): Promise<void> {
  if (input.providerType === "anthropic") {
    await pingAnthropicProvider(input.provider, input.apiKey);
    return;
  }
  if (input.providerType === "gemini") {
    await pingGeminiProvider(input.provider, input.apiKey);
    return;
  }
  await pingOpenAICompatibleProvider(input.provider, input.apiKey);
}

async function pingOpenAICompatibleProvider(provider: DesktopProviderSettings, apiKey: string): Promise<void> {
  const baseURL = (provider.baseURL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelsResponse = await fetchWithTimeout(`${baseURL}/models`, {
    method: "GET",
    headers: {
      ...(provider.authMode !== "none" ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (modelsResponse.ok) return;
  if (modelsResponse.status !== 404 && modelsResponse.status !== 405) {
    throw new Error(await buildHttpError(modelsResponse, "OpenAI-compatible"));
  }

  const chatResponse = await fetchWithTimeout(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.authMode !== "none" ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model?.trim() || "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    }),
  });
  if (!chatResponse.ok) {
    throw new Error(await buildHttpError(chatResponse, "OpenAI-compatible"));
  }
}

async function pingAnthropicProvider(provider: DesktopProviderSettings, apiKey: string): Promise<void> {
  const baseURL = (provider.baseURL?.trim() || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseURL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: provider.model?.trim() || "claude-3-5-sonnet-latest",
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    }),
  });
  if (!response.ok) {
    throw new Error(await buildHttpError(response, "Anthropic"));
  }
}

async function pingGeminiProvider(provider: DesktopProviderSettings, apiKey: string): Promise<void> {
  const baseURL = (provider.baseURL?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const url = new URL(`${baseURL}/models/${provider.model?.trim() || "gemini-2.5-pro"}:generateContent`);
  url.searchParams.set("key", apiKey);
  const response = await fetchWithTimeout(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    }),
  });
  if (!response.ok) {
    throw new Error(await buildHttpError(response, "Gemini"));
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`请求超时（>${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function buildHttpError(response: Response, label: string): Promise<string> {
  const text = await response.text().catch(() => "unknown error");
  const summary = text.replace(/\s+/g, " ").trim();
  return `${label} API ${response.status}: ${summary.slice(0, 240) || "unknown error"}`;
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

function coreTurnToDesktop(turn: Turn): DesktopTurn {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    role: turn.role,
    content: turn.content,
    createdAt: turn.createdAt.toISOString(),
  };
}

function coreTurnToConversationEntry(turn: Turn): DesktopConversationEntry | null {
  const content = turn.content.trim();
  if (!content) return null;
  const role = turn.role;
  return {
    id: `turn:${turn.id}`,
    sessionId: turn.sessionId,
    runId: null,
    source: "turn",
    kind: role === "system" ? "system" : "message",
    role,
    from: role === "user" ? "你" : role === "system" ? "系统" : "拾光 Agent",
    content,
    createdAt: turn.createdAt.toISOString(),
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

function isMeaningfulContextCompactionEvent(event: RunEvent): boolean {
  if (event.kind !== "context_compacted") return false;
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : {};
  if (payload.compressionTriggered !== true) return false;
  const originalBudget = typeof payload.originalBudget === "number" ? payload.originalBudget : 0;
  const finalBudget = typeof payload.finalBudget === "number" ? payload.finalBudget : originalBudget;
  const savedBudget = originalBudget - finalBudget;
  if (savedBudget <= 0) return false;
  if (payload.usedLlmCompactor === true) return true;
  const savedRatio = originalBudget > 0 ? savedBudget / originalBudget : 0;
  const budgetPressure = typeof payload.budgetPressure === "number" ? payload.budgetPressure : 0;
  return budgetPressure >= 0.95 && (savedBudget >= 1024 || savedRatio >= 0.2);
}

function coreEventToConversationEntry(sessionId: string, event: RunEvent): DesktopConversationEntry | null {
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown>
    : undefined;

  if (event.kind === "error") {
    const content = typeof payload?.message === "string"
      ? payload.message.trim()
      : formatConversationPayload(payload);
    if (!content) return null;
    return {
      id: `event:${event.id}`,
      sessionId,
      runId: event.runId,
      source: "event",
      kind: "error",
      role: "system",
      from: "系统",
      content,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    };
  }

  if (
    event.kind !== "system"
    && event.kind !== "approval_request"
    && event.kind !== "approval_granted"
    && event.kind !== "approval_denied"
  ) {
    return null;
  }

  const title = event.kind === "approval_request"
    ? "请求审批"
    : event.kind === "approval_granted"
      ? "审批通过"
      : event.kind === "approval_denied"
        ? "审批拒绝"
        : "系统消息";
  const body = typeof payload?.message === "string"
    ? payload.message.trim()
    : typeof payload?.content === "string"
      ? payload.content.trim()
      : "";
  const content = body ? `${title}\n${body}` : title;
  return {
    id: `event:${event.id}`,
    sessionId,
    runId: event.runId,
    source: "event",
    kind: event.kind,
    role: "system",
    from: "系统",
    content,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

function formatConversationPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function compareConversationEntries(a: DesktopConversationEntry, b: DesktopConversationEntry): number {
  const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (timeDiff !== 0) return timeDiff;
  if (a.source !== b.source) {
    return a.source === "turn" ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
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

function desktopAttachmentFromPath(filePath: string): DesktopAttachment {
  let size: number | null = null;
  try {
    size = statSync(filePath).size;
  } catch {}
  return {
    name: filePath.split(/[\\/]/).pop() ?? filePath,
    path: filePath,
    uri: pathToFileURL(filePath).href,
    size,
  };
}

function buildUserMessageWithAttachments(message: string, attachments: DesktopAttachment[]): string {
  const trimmed = message.trim();
  const attachmentBlock = formatAttachmentPrompt(attachments);
  if (!attachmentBlock) return trimmed;
  return [trimmed, attachmentBlock].filter(Boolean).join("\n\n");
}

function formatAttachmentPrompt(attachments: DesktopAttachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map((attachment) => `- ${attachment.name} (${attachment.path})`);
  return [
    "User attached local files for this run.",
    "Use read/search/stat tools against these paths when relevant:",
    ...lines,
  ].join("\n");
}

function truncateInline(text: string | null | undefined, maxLength = 180): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function buildBranchSuggestedPrompt(input: {
  sourceSession: DesktopSession;
  sourceRun: DesktopRun;
  latestUserMessage: string;
  artifacts: DesktopArtifact[];
}): string {
  const artifactLines = input.artifacts.map((artifact) => {
    const label = artifact.title?.trim() || artifact.kind;
    return `- ${label} (${artifact.uri})`;
  });
  return [
    "这是一个从历史运行分出来的新会话，请直接沿着原上下文继续，不要从零开始。",
    `来源会话：${input.sourceSession.title}`,
    `来源运行：${input.sourceRun.id}`,
    `原始任务：${truncateInline(input.latestUserMessage.trim() || "继续当前任务", 240)}`,
    `当时状态：${branchStatusLabel(input.sourceRun.status)}`,
    input.sourceRun.summary ? `运行摘要：${truncateInline(input.sourceRun.summary, 240)}` : null,
    input.sourceRun.reason ? `结束原因：${truncateInline(input.sourceRun.reason, 240)}` : null,
    artifactLines.length > 0 ? ["可复用产物：", ...artifactLines].join("\n") : null,
    "先检查上面这次运行的结论、报错和产物，再决定下一步；如果需要修复，做最小修改并重新验证。",
  ].filter((item): item is string => Boolean(item)).join("\n\n");
}

function branchStatusLabel(status: DesktopRun["status"]): string {
  if (status === "pending") return "排队中";
  if (status === "running") return "运行中";
  if (status === "paused") return "暂停后继续";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败后继续";
  if (status === "cancelled") return "已取消后继续";
  if (status === "needs_approval") return "审批中断后继续";
  return status;
}

function resolveLocalArtifactPath(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  if (isAbsolute(uri) || /^[a-zA-Z]:[\/]/.test(uri)) {
    return normalize(uri);
  }
  return null;
}

function assertArtifactPathExists(targetPath: string) {
  try {
    return statSync(targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`产物路径不可用：${targetPath} (${message})`);
  }
}

function coreArtifactToDesktop(artifact: Artifact): DesktopArtifact {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    taskId: artifact.taskId,
    runId: artifact.runId,
    kind: artifact.kind,
    uri: artifact.uri,
    title: artifact.title,
    metadata: artifact.metadata ?? {},
    createdAt: artifact.createdAt.toISOString(),
  };
}

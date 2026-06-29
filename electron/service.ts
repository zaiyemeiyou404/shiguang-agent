import { DesktopStore } from "./store.js";
import { BrowserWindow } from "electron";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSessionDetail } from "./types.js";
import { Agent } from "../dist/app/agent.js";
import { InMemoryEventSink } from "../dist/runtime/event-sink.js";
import { InMemoryRunStore } from "../dist/state/run-store.js";
import { createReadTextFileTool } from "../dist/tools/builtins/read-text-file.js";
import { createSearchWorkspaceTool } from "../dist/tools/builtins/search-workspace.js";
import { createPlanner } from "./planner-factory.js";
import { resolve, normalize } from "node:path";

let seqCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seqCounter}`;
}

export class DesktopService {
  private store: DesktopStore;
  private windows: Set<BrowserWindow> = new Set();

  constructor(store: DesktopStore) {
    this.store = store;
  }

  addWindow(win: BrowserWindow): void {
    this.windows.add(win);
    win.on("closed", () => this.windows.delete(win));
  }

  listSessions(): DesktopSession[] {
    return this.store.listSessions();
  }

  createSession(title?: string): DesktopSession {
    const now = new Date().toISOString();
    const session: DesktopSession = {
      id: nextId("sess"),
      title: title || "New Session",
      status: "active",
      createdAt: now,
      updatedAt: now,
      summary: null,
    };
    return this.store.createSession(session);
  }

  getSessionDetail(sessionId: string): DesktopSessionDetail {
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const runs = this.store.listRunsBySession(sessionId);
    return { session, runs };
  }

  async sendUserMessage(sessionId: string, message: string): Promise<DesktopRun> {
    let session = this.store.getSession(sessionId);
    if (!session) {
      session = this.createSession("Auto-created session");
      sessionId = session.id;
    }

    const runId = nextId("run");
    const run: DesktopRun = {
      id: runId,
      sessionId,
      status: "pending",
      reason: null,
      startedAt: null,
      endedAt: null,
      summary: null,
    };
    this.store.createRun(run);

    const sink = new InMemoryEventSink();
    const runStore = new InMemoryRunStore();

    const { planner, label } = createPlanner();
    const workspaceRoot = resolve(normalize(process.env.SHIGUANG_WORKSPACE_ROOT ?? process.cwd()));
    const tools = [
      createReadTextFileTool(workspaceRoot),
      createSearchWorkspaceTool(workspaceRoot),
    ];
    const agent = new Agent({ eventSink: sink, runStore, planner, tools });

    (async () => {
      this.store.updateRun(runId, { status: "running", startedAt: new Date().toISOString() });

      const userEvent: DesktopEvent = {
        id: nextId("evt"),
        runId,
        seq: 0,
        kind: "message",
        payload: { role: "user", content: message },
        createdAt: new Date().toISOString(),
      };
      this.store.createEvent(userEvent);
      this.broadcastEvent(userEvent);

      try {
        const output = await agent.run({
        runId,
        userMessage: message,
        contextInput: {
          task: { id: `task_${runId}`, sessionId, parentTaskId: null, title: message.slice(0, 80), description: null, status: "in_progress", priority: 0, createdAt: new Date(), updatedAt: new Date() },
          recentRuns: [],
          linkedArtifacts: [],
          memories: [],
        },
      });
        const storedEvents = await sink.list(runId);

        for (const evt of storedEvents) {
          const desktopEvent: DesktopEvent = {
            id: evt.id,
            runId: evt.runId,
            seq: evt.seq,
            kind: evt.kind,
            payload: evt.payload,
            createdAt: evt.createdAt instanceof Date ? evt.createdAt.toISOString() : String(evt.createdAt),
          };
          this.store.createEvent(desktopEvent);
          this.broadcastEvent(desktopEvent);
        }

        const lastResult = output.state.lastResult;
        const stepsSummary = `${output.state.steps} step(s)`;
        const plannerLabel = `planner:${label}`;
        const contentBrief = lastResult
          ? (typeof lastResult.output === "string" ? lastResult.output.slice(0, 120) : JSON.stringify(lastResult.output).slice(0, 120))
          : "Completed";
        const summary = `[${plannerLabel}] ${stepsSummary} — ${contentBrief}`;
        this.store.updateRun(runId, { status: "completed", endedAt: new Date().toISOString(), summary });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        this.store.updateRun(runId, { status: "failed", endedAt: new Date().toISOString(), reason });

        const errorEvent: DesktopEvent = {
          id: nextId("evt"),
          runId,
          seq: 9999,
          kind: "error",
          payload: { message: reason },
          createdAt: new Date().toISOString(),
        };
        this.store.createEvent(errorEvent);
        this.broadcastEvent(errorEvent);
      }

      const sessionRuns = this.store.listRunsBySession(sessionId);
      const completedCount = sessionRuns.filter((r) => r.status === "completed").length;
      this.store.updateSession(sessionId, {
        updatedAt: new Date().toISOString(),
        summary: `${sessionRuns.length} run(s), ${completedCount} completed`,
      });
    })();

    return run;
  }

  getRunEvents(runId: string): DesktopEvent[] {
    return this.store.listEventsByRun(runId);
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
}

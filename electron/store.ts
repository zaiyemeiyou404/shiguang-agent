import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DesktopSession, DesktopRun, DesktopEvent } from "./types.js";
import { getShiguangWorkspacePolicy } from "./user-data.js";

interface StoreData {
  sessions: DesktopSession[];
  runs: DesktopRun[];
  events: DesktopEvent[];
}

export class DesktopStore {
  private data: StoreData;
  private filePath: string;

  constructor() {
    const policy = getShiguangWorkspacePolicy();
    if (!existsSync(dirname(policy.storePath))) {
      mkdirSync(dirname(policy.storePath), { recursive: true });
    }
    this.filePath = policy.storePath;
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as StoreData;
      }
    } catch {
    }
    return { sessions: [], runs: [], events: [] };
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  listSessions(): DesktopSession[] {
    return this.data.sessions;
  }

  getSession(id: string): DesktopSession | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  createSession(session: DesktopSession): DesktopSession {
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  updateSession(id: string, patch: Partial<DesktopSession>): DesktopSession | undefined {
    const idx = this.data.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return undefined;
    this.data.sessions[idx] = { ...this.data.sessions[idx], ...patch };
    this.save();
    return this.data.sessions[idx];
  }

  deleteSession(id: string): boolean {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((session) => session.id !== id);
    if (this.data.sessions.length === before) return false;
    this.save();
    return true;
  }

  createRun(run: DesktopRun): DesktopRun {
    this.data.runs.push(run);
    this.save();
    return run;
  }

  getRun(id: string): DesktopRun | undefined {
    return this.data.runs.find((r) => r.id === id);
  }

  updateRun(id: string, patch: Partial<DesktopRun>): DesktopRun | undefined {
    const idx = this.data.runs.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    this.data.runs[idx] = { ...this.data.runs[idx], ...patch };
    this.save();
    return this.data.runs[idx];
  }

  listRunsBySession(sessionId: string): DesktopRun[] {
    return this.data.runs.filter((r) => r.sessionId === sessionId);
  }

  createEvent(event: DesktopEvent): DesktopEvent {
    this.data.events.push(event);
    this.save();
    return event;
  }

  listEventsByRun(runId: string): DesktopEvent[] {
    return this.data.events.filter((e) => e.runId === runId);
  }
}

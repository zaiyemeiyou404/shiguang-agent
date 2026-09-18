import type { RunLifecycleCommand } from "./types.js";
import type { EventSink } from "./event-sink.js";
import type { Run, RunStatus } from "../core/types.js";

export interface RunStore {
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Run>): Promise<void>;
}

export class RuntimeCoordinator {
  constructor(
    private store: RunStore,
    private sink: EventSink,
  ) {}

  async handle(cmd: RunLifecycleCommand): Promise<void> {
    // coordinator 只维护 run 生命周期和事件落库，不参与 planner/dispatcher 细节。
    switch (cmd.type) {
      case "start": {
        const now = new Date();
        await this.store.updateRun(cmd.runId, {
          status: "running",
          startedAt: now,
          model: cmd.model ?? null,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run started",
          model: cmd.model,
        });
        break;
      }
      case "resume": {
        await this.store.updateRun(cmd.runId, {
          status: "running",
          reason: null,
          model: cmd.model ?? null,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run resumed",
          model: cmd.model,
        });
        break;
      }
      case "pause": {
        await this.store.updateRun(cmd.runId, {
          status: "paused",
          reason: cmd.reason ?? null,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run paused",
          reason: cmd.reason,
        });
        break;
      }
      case "wait_for_approval": {
        await this.store.updateRun(cmd.runId, {
          status: "needs_approval",
          reason: cmd.reason,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run waiting for approval",
          reason: cmd.reason,
        });
        break;
      }
      case "wait_for_user": {
        await this.store.updateRun(cmd.runId, {
          status: "waiting_user",
          reason: cmd.reason,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run waiting for user",
          reason: cmd.reason,
        });
        break;
      }
      case "block": {
        const now = new Date();
        await this.store.updateRun(cmd.runId, {
          status: "blocked",
          reason: cmd.reason,
          endedAt: now,
        });
        await this.sink.record(cmd.runId, "error", {
          message: "run blocked",
          reason: cmd.reason,
        });
        break;
      }
      case "verify": {
        await this.store.updateRun(cmd.runId, { status: "verifying" });
        await this.sink.record(cmd.runId, "system", { message: "run verifying" });
        break;
      }
      case "append_event": {
        await this.sink.record(cmd.runId, cmd.kind, cmd.payload);
        break;
      }
      case "finish": {
        const now = new Date();
        await this.store.updateRun(cmd.runId, {
          status: "completed",
          endedAt: now,
          summary: cmd.summary ?? null,
        });
        await this.sink.record(cmd.runId, "system", {
          message: "run finished",
          summary: cmd.summary,
        });
        break;
      }
      case "fail": {
        const now = new Date();
        await this.store.updateRun(cmd.runId, {
          status: "failed",
          endedAt: now,
          reason: cmd.reason,
        });
        await this.sink.record(cmd.runId, "error", { message: cmd.reason });
        break;
      }
      case "cancel": {
        const now = new Date();
        await this.store.updateRun(cmd.runId, {
          status: "cancelled",
          endedAt: now,
        });
        await this.sink.record(cmd.runId, "system", { message: "run cancelled" });
        break;
      }
    }
  }
}

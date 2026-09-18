import type { RunEvent, RunEventKind } from "../core/types.js";
import type { RunEventRepository } from "../state/repositories.js";
import { redactEventPayload } from "./redact-event-payload.js";

export interface EventSink {
  record(runId: string, kind: RunEventKind, payload: unknown): Promise<RunEvent>;
  list(runId: string): Promise<RunEvent[]>;
}

export class InMemoryEventSink implements EventSink {
  private events: RunEvent[] = [];
  private seqByRun = new Map<string, number>();

  async record(runId: string, kind: RunEventKind, payload: unknown): Promise<RunEvent> {
    const seq = (this.seqByRun.get(runId) ?? 0) + 1;
    this.seqByRun.set(runId, seq);
    const event: RunEvent = {
      id: `evt_${runId}_${seq}`,
      runId,
      seq,
      kind,
      payload: redactEventPayload(payload),
      createdAt: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async list(runId: string): Promise<RunEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }
}

export class RepositoryEventSink implements EventSink {
  constructor(
    private readonly repository: RunEventRepository,
    private readonly onRecord?: (event: RunEvent) => void | Promise<void>,
  ) {}

  async record(runId: string, kind: RunEventKind, payload: unknown): Promise<RunEvent> {
    const existing = await this.repository.listByRun(runId);
    const seq = existing.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
    const event: RunEvent = {
      id: `evt_${runId}_${seq}`,
      runId,
      seq,
      kind,
      payload: redactEventPayload(payload),
      createdAt: new Date(),
    };

    await this.repository.create(event);
    await this.onRecord?.(event);
    return event;
  }

  async list(runId: string): Promise<RunEvent[]> {
    return this.repository.listByRun(runId);
  }
}

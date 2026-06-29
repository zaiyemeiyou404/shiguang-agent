import type { RunEvent, RunEventKind } from "../core/types.js";

export interface EventSink {
  record(runId: string, kind: RunEventKind, payload: unknown): Promise<RunEvent>;
  list(runId: string): Promise<RunEvent[]>;
}

export class InMemoryEventSink implements EventSink {
  private events: RunEvent[] = [];
  private seq = 0;

  async record(runId: string, kind: RunEventKind, payload: unknown): Promise<RunEvent> {
    const event: RunEvent = {
      id: `evt_${runId}_${++this.seq}`,
      runId,
      seq: this.seq,
      kind,
      payload,
      createdAt: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async list(runId: string): Promise<RunEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }
}

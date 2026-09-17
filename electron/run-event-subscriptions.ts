import type { DesktopEvent } from "./types.js";

export interface RunEventSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, event: DesktopEvent): void;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface RunEventSource {
  subscribeRunEvents(runId: string, callback: (event: DesktopEvent) => void): () => void;
}

export class RunEventSubscriptionRegistry {
  private readonly subscriptions = new Map<string, () => void>();
  private readonly watchedSenders = new Set<number>();

  constructor(private readonly source: RunEventSource) {}

  get size(): number {
    return this.subscriptions.size;
  }

  subscribe(sender: RunEventSender, runId: string, subscriptionId: string): void {
    const key = this.key(sender.id, subscriptionId);
    this.unsubscribe(sender.id, subscriptionId);
    const release = this.source.subscribeRunEvents(runId, (event) => {
      if (!sender.isDestroyed()) sender.send(`run-event:${subscriptionId}`, event);
    });
    this.subscriptions.set(key, release);

    if (!this.watchedSenders.has(sender.id)) {
      this.watchedSenders.add(sender.id);
      sender.once("destroyed", () => this.releaseSender(sender.id));
    }
  }

  unsubscribe(senderId: number, subscriptionId: string): void {
    const key = this.key(senderId, subscriptionId);
    const release = this.subscriptions.get(key);
    if (!release) return;
    this.subscriptions.delete(key);
    release();
  }

  releaseSender(senderId: number): void {
    const prefix = `${senderId}:`;
    for (const [key, release] of this.subscriptions) {
      if (!key.startsWith(prefix)) continue;
      this.subscriptions.delete(key);
      release();
    }
    this.watchedSenders.delete(senderId);
  }

  private key(senderId: number, subscriptionId: string): string {
    return `${senderId}:${subscriptionId}`;
  }
}

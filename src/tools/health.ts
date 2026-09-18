export type ToolHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ToolHealthSnapshot {
  toolName: string;
  attempts: number;
  successes: number;
  failures: number;
  retryableFailures: number;
  consecutiveFailures: number;
  averageDurationMs: number;
  lastDurationMs: number | null;
  lastErrorKind: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  status: ToolHealthStatus;
}

type MutableHealth = Omit<ToolHealthSnapshot, "status" | "toolName">;

/** Runtime-only health ledger. It is diagnostic metadata, never an execution permission. */
export class ToolHealthTracker {
  private readonly records = new Map<string, MutableHealth>();

  recordSuccess(toolName: string, durationMs: number): ToolHealthSnapshot {
    const record = this.getOrCreate(toolName);
    record.attempts += 1;
    record.successes += 1;
    record.consecutiveFailures = 0;
    record.lastDurationMs = durationMs;
    record.averageDurationMs = nextAverage(record.averageDurationMs, record.attempts, durationMs);
    record.lastSuccessAt = new Date();
    return this.snapshot(toolName);
  }

  recordFailure(toolName: string, durationMs: number, errorKind: string, retryable: boolean): ToolHealthSnapshot {
    const record = this.getOrCreate(toolName);
    record.attempts += 1;
    record.failures += 1;
    if (retryable) record.retryableFailures += 1;
    record.consecutiveFailures += 1;
    record.lastDurationMs = durationMs;
    record.averageDurationMs = nextAverage(record.averageDurationMs, record.attempts, durationMs);
    record.lastErrorKind = errorKind;
    record.lastFailureAt = new Date();
    return this.snapshot(toolName);
  }

  snapshot(toolName: string): ToolHealthSnapshot {
    const record = this.getOrCreate(toolName);
    return { toolName, ...record, status: statusFor(record) };
  }

  all(): ToolHealthSnapshot[] {
    return [...this.records.keys()].sort().map((name) => this.snapshot(name));
  }

  private getOrCreate(toolName: string): MutableHealth {
    const existing = this.records.get(toolName);
    if (existing) return existing;
    const created: MutableHealth = {
      attempts: 0,
      successes: 0,
      failures: 0,
      retryableFailures: 0,
      consecutiveFailures: 0,
      averageDurationMs: 0,
      lastDurationMs: null,
      lastErrorKind: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    this.records.set(toolName, created);
    return created;
  }
}

function nextAverage(previous: number, count: number, durationMs: number): number {
  if (count <= 1) return durationMs;
  return Math.round(((previous * (count - 1)) + durationMs) / count);
}

function statusFor(record: MutableHealth): ToolHealthStatus {
  if (record.consecutiveFailures >= 3) return "unavailable";
  if (record.consecutiveFailures > 0 || record.failures > record.successes) return "degraded";
  return "healthy";
}

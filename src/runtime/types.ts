import type { RunStatus, RunEventKind, ToolCallStatus } from "../core/types.js";

export interface RuntimeConfig {
  defaultModel: string;
  maxEventsPerRun: number;
  idleTimeoutMs: number;
}

export type RunLifecycleCommand =
  | { type: "start"; runId: string; model?: string }
  | { type: "append_event"; runId: string; kind: RunEventKind; payload: unknown }
  | { type: "finish"; runId: string; summary?: string }
  | { type: "fail"; runId: string; reason: string }
  | { type: "cancel"; runId: string };

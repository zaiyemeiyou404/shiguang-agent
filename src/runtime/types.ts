import type { RunStatus, RunEventKind, ToolCallStatus } from "../core/types.js";

export interface RuntimeConfig {
  defaultModel: string;
  maxEventsPerRun: number;
  idleTimeoutMs: number;
}

export type RunLifecycleCommand =
  | { type: "start"; runId: string; model?: string }
  | { type: "resume"; runId: string; model?: string }
  | { type: "pause"; runId: string; reason?: string }
  | { type: "wait_for_approval"; runId: string; reason: string }
  | { type: "wait_for_user"; runId: string; reason: string }
  | { type: "block"; runId: string; reason: string }
  | { type: "verify"; runId: string }
  | { type: "append_event"; runId: string; kind: RunEventKind; payload: unknown }
  | { type: "finish"; runId: string; summary?: string }
  | { type: "fail"; runId: string; reason: string }
  | { type: "cancel"; runId: string };

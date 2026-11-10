import type { ExecutionGrant, ExecutionPreset } from "./types.js";

export const DEFAULT_EXECUTION_PRESET: ExecutionPreset = "workspace_write_network";

const EXECUTION_PRESETS: readonly ExecutionPreset[] = [
  "read_only",
  "workspace_write",
  "workspace_write_network",
  "full_access",
];

export function normalizeExecutionPreset(value: unknown): ExecutionPreset {
  return EXECUTION_PRESETS.includes(value as ExecutionPreset)
    ? value as ExecutionPreset
    : DEFAULT_EXECUTION_PRESET;
}

/**
 * The four presets differ by write, terminal, network, and host access.
 * `workspace_write_network` can run commands only inside the workspace.
 * `full_access` is the only preset that may start a command outside it.
 */
export function executionGrantForPreset(preset: ExecutionPreset, workspaceRoot?: string): ExecutionGrant {
  const root = workspaceRoot ? { workspaceRoot } : {};
  switch (preset) {
    case "read_only":
      return { preset, ...root, allowRead: true, allowWrite: false, allowExecute: false, allowNetwork: false, allowHostExecute: false };
    case "workspace_write":
      return { preset, ...root, allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: false, allowHostExecute: false };
    case "workspace_write_network":
      return { preset, ...root, allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true, allowHostExecute: false };
    case "full_access":
      return { preset, ...root, allowRead: true, allowWrite: true, allowExecute: true, allowNetwork: true, allowHostExecute: true };
  }
}

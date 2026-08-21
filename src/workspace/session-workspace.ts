import { join, normalize, resolve } from "node:path";

const SESSION_METADATA_DIR = ".shiguang";
const SESSION_WORKSPACES_DIR = "sessions";

export interface SessionWorkspaceInput {
  baseWorkspaceRoot: string;
  defaultWorkspaceRoot: string;
  sessionId: string;
  existingSessionWorkspaceRoot?: string | null;
}

export function normalizeWorkspacePath(value: string): string {
  return resolve(normalize(value));
}

export function sameWorkspacePath(a: string, b: string): boolean {
  const left = normalizeWorkspacePath(a);
  const right = normalizeWorkspacePath(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function dedicatedSessionWorkspaceRoot(baseWorkspaceRoot: string, sessionId: string): string {
  return normalizeWorkspacePath(join(
    normalizeWorkspacePath(baseWorkspaceRoot),
    SESSION_METADATA_DIR,
    SESSION_WORKSPACES_DIR,
    sessionId,
  ));
}

export function shouldUseDedicatedSessionWorkspace(baseWorkspaceRoot: string, defaultWorkspaceRoot: string): boolean {
  return sameWorkspacePath(baseWorkspaceRoot, defaultWorkspaceRoot);
}

export function defaultSessionWorkspaceRoot(input: Omit<SessionWorkspaceInput, "existingSessionWorkspaceRoot">): string {
  const baseWorkspaceRoot = normalizeWorkspacePath(input.baseWorkspaceRoot);
  return shouldUseDedicatedSessionWorkspace(baseWorkspaceRoot, input.defaultWorkspaceRoot)
    ? dedicatedSessionWorkspaceRoot(baseWorkspaceRoot, input.sessionId)
    : baseWorkspaceRoot;
}

export function legacySessionWorkspaceParent(workspaceRoot: string, sessionId: string): string | null {
  const normalized = normalizeWorkspacePath(workspaceRoot);
  const portable = normalized.replace(/\\/g, "/");
  const suffix = `/${SESSION_METADATA_DIR}/${SESSION_WORKSPACES_DIR}/${sessionId}`;
  if (!portable.toLowerCase().endsWith(suffix.toLowerCase())) return null;

  const parent = portable.slice(0, -suffix.length);
  return parent ? normalizeWorkspacePath(parent) : null;
}

export function resolveSessionWorkspaceRoot(input: SessionWorkspaceInput): string {
  const existing = input.existingSessionWorkspaceRoot?.trim();
  if (existing) {
    const normalizedExisting = normalizeWorkspacePath(existing);
    const legacyParent = legacySessionWorkspaceParent(normalizedExisting, input.sessionId);

    // v0.2.24-v0.2.26 created hidden per-session folders under any configured
    // workspace. Keep that behavior only for the app-managed default workspace;
    // if the parent is a user-selected project, the project itself is the cwd.
    if (legacyParent && !sameWorkspacePath(legacyParent, input.defaultWorkspaceRoot)) {
      return legacyParent;
    }

    return normalizedExisting;
  }

  return defaultSessionWorkspaceRoot(input);
}

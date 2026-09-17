import { isAbsolute, normalize, relative, resolve } from "node:path";

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveReadablePath(workspaceRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) {
    return resolve(normalize(requestedPath));
  }
  return resolveWorkspacePath(workspaceRoot, requestedPath);
}

export function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(normalize(workspaceRoot));
  const candidate = resolve(root, normalize(requestedPath));
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path escapes workspace root: ${requestedPath}`);
  }
  return candidate;
}

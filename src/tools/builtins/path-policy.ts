import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

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

export function resolveWritablePath(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(normalize(workspaceRoot));
  const candidate = resolveWorkspacePath(root, requestedPath);
  if (!existsSync(root)) {
    throw new Error(`Workspace root is not available: ${workspaceRoot}`);
  }

  const canonicalRoot = realpathSync.native(root);
  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Cannot resolve writable path: ${requestedPath}`);
    }
    existingAncestor = parent;
  }

  const canonicalAncestor = realpathSync.native(existingAncestor);
  const canonicalCandidate = resolve(canonicalAncestor, relative(existingAncestor, candidate));
  if (!isPathInside(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Path escapes workspace root through a filesystem link: ${requestedPath}`);
  }
  return candidate;
}

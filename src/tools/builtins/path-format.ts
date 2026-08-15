import { existsSync } from "node:fs";
import { basename, dirname, normalize, relative, resolve } from "node:path";

export function toPortablePath(path: string): string {
  return normalize(path).replace(/\\/g, "/");
}

export interface ResolveWorkspacePathOptions {
  forWrite?: boolean;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  userPath = ".",
  options: ResolveWorkspacePathOptions = {},
): string {
  const root = resolve(workspaceRoot);
  const normalizedInput = normalize(userPath || ".");
  const direct = assertInsideWorkspace(root, resolve(root, normalizedInput), userPath);
  const strippedInput = stripRedundantWorkspacePrefix(root, normalizedInput);
  if (strippedInput !== normalizedInput) {
    const stripped = assertInsideWorkspace(root, resolve(root, strippedInput), userPath);
    if (shouldPreferStrippedPath(direct, stripped, options)) {
      return stripped;
    }
  }

  return direct;
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string, userPath: string): string {
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error(`Path escapes workspace root: ${userPath}`);
  }
  return candidate;
}

function stripRedundantWorkspacePrefix(workspaceRoot: string, userPath: string): string {
  const rootName = basename(workspaceRoot).toLowerCase();
  const normalizedPortable = toPortablePath(userPath);
  const rootPortable = toPortablePath(resolve(workspaceRoot)).toLowerCase();
  const absoluteDuplicatePrefix = `${rootPortable}/${rootName}/`;
  if (normalizedPortable.toLowerCase().startsWith(absoluteDuplicatePrefix)) {
    return normalizedPortable.slice(absoluteDuplicatePrefix.length);
  }

  const segments = normalizedPortable.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0]?.toLowerCase() !== rootName) {
    return userPath;
  }

  return segments.slice(1).join("/") || ".";
}

function shouldPreferStrippedPath(
  direct: string,
  stripped: string,
  options: ResolveWorkspacePathOptions,
): boolean {
  if (existsSync(direct)) return false;
  if (existsSync(stripped)) return true;
  if (!options.forWrite) return false;
  return !existsSync(dirname(direct)) && existsSync(dirname(stripped));
}

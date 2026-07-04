import { fileURLToPath, pathToFileURL } from "node:url";
import { sep, normalize, isAbsolute } from "node:path";

const WIN_DRIVE = /^[a-zA-Z]:[/\\]/;

export function isWindowsAbsolutePath(p: string): boolean {
  return WIN_DRIVE.test(p);
}

export function normalizeWindowsPath(p: string): string {
  const normalized = normalize(p).replace(/\\/g, "/");
  if (WIN_DRIVE.test(p)) {
    const drive = normalized[0]!.toLowerCase();
    return `/${drive}:/${normalized.slice(3)}`;
  }
  return normalized;
}

export function windowsPathToFileUri(p: string): string {
  const normalized = normalize(p).replace(/\\/g, "/");
  const drive = normalized[0]!.toUpperCase();
  return `file:///${drive}:${normalized.slice(2).startsWith("/") ? "" : "/"}${normalized.slice(2)}`;
}

export function toFileUri(p: string): string {
  if (isWindowsAbsolutePath(p)) {
    return windowsPathToFileUri(p);
  }
  if (isAbsolute(p)) {
    return pathToFileURL(p).href;
  }
  return pathToFileURL(normalize(p)).href;
}

export function fromFileUri(uri: string): string {
  return fileURLToPath(uri);
}

export function isFileUri(s: string): boolean {
  return s.startsWith("file://");
}

export function artifactRef(uri: string): string {
  if (isFileUri(uri)) return fromFileUri(uri);
  if (isWindowsAbsolutePath(uri)) return normalizeWindowsPath(uri);
  return uri;
}

export function platformSep(): "/" | "\\" {
  return sep;
}

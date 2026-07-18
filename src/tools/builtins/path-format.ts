import { normalize } from "node:path";

export function toPortablePath(path: string): string {
  return normalize(path).replace(/\\/g, "/");
}

import { resolve } from "node:path";

/** Synced campus cache and the login-window profile. Never the C: drive. */
export function syncedXdyouDataDir(): string {
  const override = process.env.XDYOU_SYNC_DIR?.trim();
  if (override) return resolve(override);
  return resolve("G:\\CodexData\\shiguang-agent-data\\xdyou");
}

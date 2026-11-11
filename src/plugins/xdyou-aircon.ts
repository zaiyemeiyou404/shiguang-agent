import { readFileSync } from "node:fs";
import { join } from "node:path";

const AIRCON_STATE_URL = "https://gxkt.juhaolian.cn/api/device/direct/state";
const AIRCON_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";
const MODES = ["送风", "制热", "制冷", "除湿", "自动"];
const SPEEDS = ["自动", "静音", "低", "中", "高"];

export function projectAirconState(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  const result = asRecord(root?.result) ?? root;
  if (!result) return { ok: false, dataset: "airconlive", error: "空调没有返回状态。" };
  const amount = finite(result.electricAmount);
  const updated = finite(result.timestamp);
  return {
    ok: true,
    dataset: "airconlive",
    deviceSuffix: text(result.imei).slice(-4),
    on: finite(result.switchStatus) === 1,
    mode: MODES[finite(result.runMode)] ?? "",
    wind: SPEEDS[finite(result.windSpeed)] ?? "",
    targetTemperature: finite(result.tempSet),
    indoorTemperature: result.indoorTemp === undefined || result.indoorTemp === null ? null : finite(result.indoorTemp),
    electricAmount: amount,
    ...(updated > 0 ? { stateTime: new Date(updated * 1000).toISOString() } : {}),
  };
}

export async function queryAirconLive(query: string, dataDir: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const imei = /^\d{8,20}$/.test(query) ? query : readImei(dataDir);
  if (!imei) return { ok: false, dataset: "airconlive", error: "还没有空调设备号。先在 XDYou 里打开一次空调页面。" };
  const response = await fetch(`${AIRCON_STATE_URL}?imei=${encodeURIComponent(imei)}`, {
    signal,
    headers: { accept: "application/json", "user-agent": AIRCON_UA },
  });
  const payload = await response.json().catch(() => null) as { success?: unknown; message?: unknown } | null;
  if (!payload || payload.success !== true) {
    return { ok: false, dataset: "airconlive", error: typeof payload?.message === "string" && payload.message ? payload.message : "空调状态没有返回。" };
  }
  return projectAirconState(payload);
}

function readImei(dataDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "AirconEnergyCache.json"), "utf8")) as { imei?: unknown };
    return typeof parsed.imei === "string" && /^\d{8,20}$/.test(parsed.imei) ? parsed.imei : "";
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function finite(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

const WATER_BASE = "https://i.ilife798.com";
const WATER_UA = "iOS_ilife798_3.1.9";
const CAPTCHA_UA = "iLife798/3.1.9 (iPhone; iOS 26.2; Scale/3.00)";

export interface WaterCaptcha {
  sessionId: string;
  imageBase64: string;
}

export async function fetchWaterCaptcha(signal?: AbortSignal): Promise<WaterCaptcha> {
  const sessionId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join("");
  const response = await fetch(`${WATER_BASE}/api/v1/captcha/?s=${sessionId}&r=${Date.now()}`, {
    signal,
    headers: { accept: "*/*", "user-agent": CAPTCHA_UA, VersionCode: "3.1.9" },
  });
  if (!response.ok) throw new Error(`宿舍水机验证码返回 HTTP ${response.status}`);
  return { sessionId, imageBase64: Buffer.from(await response.arrayBuffer()).toString("base64") };
}

export async function sendWaterSms(sessionId: string, phone: string, imageCode: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const payload = await waterPost("/api/v1/acc/login/code", { s: sessionId, authCode: imageCode, un: phone }, signal);
  if (payload.code !== 0) return { ok: false, error: hidePhone(text(payload.msg) || "短信没有发出。", phone) };
  return { ok: true };
}

export async function loginAndQueryWater(phone: string, smsCode: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const payload = await waterPost("/api/v1/acc/login", { cid: "", authCode: smsCode, un: phone }, signal);
  if (payload.code !== 0) return { ok: false, dataset: "water", error: hidePhone(text(payload.msg) || "宿舍水机登录没有成功。", phone) };
  const data = asRecord(asRecord(payload.data)?.al);
  const token = text(data?.token);
  if (!token) return { ok: false, dataset: "water", error: "宿舍水机登录没有返回可用会话。" };
  writeFileSync(join(syncedXdyouDataDir(), "water-session.json"), JSON.stringify({ token }), "utf8");
  return queryWater({ token }, signal);
}

export function readWaterSession(): { token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(syncedXdyouDataDir(), "water-session.json"), "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token ? { token: parsed.token } : null;
  } catch {
    return null;
  }
}

export function clearWaterSession(): void {
  rmSync(join(syncedXdyouDataDir(), "water-session.json"), { force: true });
}

export async function queryWater(session: { token: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${WATER_BASE}/api/v1/ui/app/master`, {
    signal,
    headers: { accept: "*/*", authorization: session.token, "user-agent": WATER_UA, VersionCode: "3.1.9" },
  });
  const payload = asRecord(await response.json().catch(() => null));
  if (!payload || payload.code !== 0) return { ok: false, dataset: "water", error: text(payload?.msg) || "宿舍水机没有返回设备。" };
  return projectWater(payload);
}

export function projectWater(payload: unknown): Record<string, unknown> {
  const data = asRecord(asRecord(payload)?.data) ?? {};
  if (!asRecord(data.account)) return { ok: false, dataset: "water", error: "宿舍水机会话已失效。" };
  const devices = (Array.isArray(data.favos) ? data.favos : []).slice(0, 20).flatMap((item) => {
    const name = text(asRecord(item)?.name);
    return name ? [{ name }] : [];
  });
  const account = asRecord(data.account) ?? {};
  const balance: Record<string, string> = {};
  for (const [key, value] of Object.entries(account)) {
    if (/token|phone|mobile|password|uid|eid|^id$|^un$/i.test(key)) continue;
    if (!/balance|money|amount|remain|cash|credit|yuan/i.test(key)) continue;
    const shown = text(value);
    if (shown) balance[key] = shown;
  }
  return { ok: true, dataset: "water", count: devices.length, devices, ...(Object.keys(balance).length > 0 ? { balance } : {}) };
}

async function waterPost(path: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${WATER_BASE}${path}`, {
    method: "POST",
    signal,
    headers: { accept: "*/*", "content-type": "application/json", "user-agent": WATER_UA, VersionCode: "3.1.9" },
    body: JSON.stringify(body),
  });
  return asRecord(await response.json().catch(() => null)) ?? {};
}

function hidePhone(message: string, phone: string): string {
  return phone ? message.split(phone).join("(hidden)") : message;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

import type { SessionPage } from "./xdyou-personal.js";

export const METERS_LOGIN_URL = "https://xxcapp.xidian.edu.cn/uc/api/oauth/index?redirect=https%3A%2F%2Fignypt.xidian.edu.cn%2FrevenueH5%2Flogin%3Fopcode%3DMPAY%26appid%3D200260318155520600%26state%3D12312312312312%26qrcode%3D0";

export function projectMeters(pageText: string): Record<string, unknown> {
  if (/只能在校园网|非校园网|不在校内|请连接校园网/.test(pageText)) {
    return { ok: false, dataset: "meters", error: "水电查询只能在校园网内使用。" };
  }
  const lines = pageText.split(/\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => {
    return /电|水|度|吨|余额|表/.test(line) && /\d/.test(line) && line.length <= 40;
  }).slice(0, 12);
  if (lines.length === 0) return { ok: false, dataset: "meters", needsLogin: true, error: "水电页面还没有余额。" };
  return { ok: true, dataset: "meters", lines };
}

export async function fetchMeters(page: SessionPage): Promise<Record<string, unknown>> {
  const host = hostname(page.location());
  if (host === "ids.xidian.edu.cn" || host === "xxcapp.xidian.edu.cn" || host === "") {
    return { ok: false, dataset: "meters", needsLogin: true, error: "水电还需要完成统一认证。" };
  }
  const pageText = text(await page.evaluate(`document.body ? document.body.innerText.slice(0, 4000) : ""`));
  return projectMeters(pageText);
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

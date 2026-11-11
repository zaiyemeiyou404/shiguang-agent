import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

const LOGIN_TIMEOUT_MS = 360_000;

export async function openXdyouLogin(signal?: AbortSignal): Promise<Record<string, unknown>> {
  return runXdyouWindow(["login"], "last-login.json", signal);
}

export async function openXdyouClassrooms(building: string, date: string, semesterCode: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return runXdyouWindow(["classrooms", building, date, semesterCode], "last-classrooms.json", signal);
}

export async function openXdyouSession(mode: "card" | "loans" | "schoolnet" | "forum" | "sport" | "sportclass" | "attendance" | "meters" | "water", signal?: AbortSignal): Promise<Record<string, unknown>> {
  return runXdyouWindow([mode], `last-${mode}.json`, signal);
}

async function runXdyouWindow(args: string[], resultName: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
  const resultPath = join(syncedXdyouDataDir(), resultName);
  rmSync(resultPath, { force: true });
  const script = fileURLToPath(new URL("./xdyou-login-window.js", import.meta.url));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(electronBinary(), [script, resultPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      env: electronEnv(),
    });
  } catch (error) {
    return { ok: false, dataset: args[0] ?? "login", error: error instanceof Error ? error.message : String(error) };
  }

  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8");
    if (!/GPU|cache|vk_swiftshader|Electron/i.test(line)) output.push(line);
  });

  const onAbort = () => child.kill();
  signal?.addEventListener("abort", onAbort);
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, LOGIN_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  signal?.removeEventListener("abort", onAbort);

  const fromFile = readResult(resultPath);
  if (fromFile) return fromFile;
  const marker = output.join("").split("\n").find((line) => line.startsWith("XDYOU_LOGIN_RESULT:"));
  if (marker) {
    try {
      const parsed = JSON.parse(marker.slice("XDYOU_LOGIN_RESULT:".length)) as Record<string, unknown>;
      return parsed;
    } catch {
      return { ok: false, dataset: "login", error: "登录窗口返回了无法解析的结果。" };
    }
  }
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
  if (exitCode === null) return { ok: false, dataset: "login", error: "登录窗口超时。统一认证页面没有在 6 分钟内完成。" };
  return { ok: false, dataset: "login", error: "登录窗口已关闭，还没有完成同步。" };
}

function readResult(resultPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    delete record.cookie;
    delete record.cookies;
    delete record.password;
    return record;
  } catch {
    return null;
  }
}

function electronBinary(): string {
  if (process.versions.electron) return process.execPath;
  const require = createRequire(import.meta.url);
  const resolved = require("electron") as unknown;
  if (typeof resolved === "string" && resolved.trim()) return resolved;
  throw new Error("找不到 Electron，无法打开登录窗口。");
}

function electronEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

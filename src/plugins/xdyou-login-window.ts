import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { METERS_LOGIN_URL, fetchMeters } from "./xdyou-meters.js";
import { ATTENDANCE_LOGIN_URL, fetchAttendance } from "./xdyou-attendance.js";
import { EMPTY_CLASSROOM_APP, fetchEmptyClassrooms } from "./xdyou-classrooms.js";
import {
  CARD_LOGIN_URL,
  FORUM_URL,
  LOAN_LOGIN_URL,
  SCHOOLNET_HOME_URL,
  clearSportSession,
  fetchCampusCard,
  fetchForum,
  fetchLoans,
  fetchSchoolnet,
  jwtFromLocation,
  loginAndQuerySport,
  querySportClasses,
  querySportScores,
  readSportSession,
  type SessionPage,
} from "./xdyou-personal.js";
import { classTableLoginUrl, syncEhall, type EhallClient } from "./xdyou-sync.js";
import { syncedXdyouDataDir } from "./xdyou-paths.js";
import {
  clearWaterSession,
  fetchWaterCaptcha,
  loginAndQueryWater,
  queryWater,
  readWaterSession,
  sendWaterSms,
} from "./xdyou-water.js";

const dataDir = syncedXdyouDataDir();
const profileDir = join(dataDir, "browser-profile");
mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.setPath("sessionData", profileDir);

const ACCOUNT_HOOK = `(() => {
  if (window.__xdyouAccountHook) return;
  window.__xdyouAccountHook = true;
  const read = () => {
    const element = document.querySelector('#username, input[name="username"]');
    const value = element && "value" in element ? String(element.value).trim() : "";
    if (/^[0-9A-Za-z]{4,32}$/.test(value)) console.log("XDYOU_ACCOUNT:" + value);
  };
  document.addEventListener("input", read, true);
  document.addEventListener("change", read, true);
  document.addEventListener("submit", read, true);
  read();
})();`;

let studentId = "";
let finished = false;

function publish(result: Record<string, unknown>): void {
  if (finished) return;
  finished = true;
  const clean = { ...result };
  for (const key of ["password", "pwd", "token", "openid", "jwt", "cookie"]) delete clean[key];
  if (typeof clean.error === "string") {
    clean.error = clean.error.replace(/(openid|jwt|token|pwd)=([^&\s]+)/gi, "$1=(hidden)").replace(/1\d{10}/g, "(hidden)");
  }
  const body = JSON.stringify({ dataset: process.argv[3] || "login", ...clean });
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(process.argv[2] || join(dataDir, "last-login.json"), body, "utf8");
  } catch {
    // The parent also watches stdout.
  }
  process.stdout.write(`XDYOU_LOGIN_RESULT:${body}\n`);
  app.exit(result.ok === true ? 0 : 1);
}

async function main(): Promise<void> {
  await app.whenReady();
  const mode = process.argv[3] || "login";
  const titles: Record<string, string> = {
    classrooms: "空闲教室",
    card: "校园卡",
    loans: "个人借阅",
    schoolnet: "校园网账号",
    forum: "睿思",
    sport: "体测",
    sportclass: "体育课",
    attendance: "考勤",
    meters: "水电",
    water: "宿舍水机",
  };
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: titles[mode] ?? "西电统一身份认证",
    show: mode === "login",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => publish({
    ok: false,
    error: mode === "login"
      ? "登录窗口已关闭，还没有完成统一身份认证。"
      : mode === "meters"
        ? "水电页面已关闭，没有读到余额。这个查询通常要在校园网里完成。"
        : mode === "water"
          ? "宿舍水机窗口已关闭，还没有完成短信登录。"
          : "窗口已关闭，还没有完成查询。",
  }));
  win.webContents.on("console-message", (event: unknown, _level?: number, message?: string) => {
    const text = typeof message === "string"
      ? message
      : event && typeof event === "object" && "message" in event
        ? String((event as { message: unknown }).message)
        : "";
    const match = text.match(/^XDYOU_ACCOUNT:([0-9A-Za-z]{4,32})$/);
    if (match?.[1]) studentId = match[1];
  });
  win.webContents.on("dom-ready", () => {
    void win.webContents.executeJavaScript(ACCOUNT_HOOK).catch(() => undefined);
  });
  const revealLogin = () => {
    if (win.isDestroyed()) return;
    try {
      if (new URL(win.webContents.getURL()).hostname === "ids.xidian.edu.cn") win.show();
    } catch {
      // The page has not navigated yet.
    }
  };
  win.webContents.on("did-navigate", revealLogin);
  win.webContents.on("did-finish-load", revealLogin);

  const client: EhallClient = {
    async open(url: string) {
      await loadUrl(win, url);
      await waitForEhall(win);
    },
    async post(url: string, fields: Record<string, string> = {}) {
      const response = await win.webContents.session.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          referer: "https://ehall.xidian.edu.cn/new/index_xd.html",
        },
        body: new URLSearchParams(fields),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`教务接口返回 HTTP ${response.status}`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("教务接口返回的不是 JSON，登录会话可能还没进入该应用。");
      }
    },
  };

  try {
    if (mode === "classrooms") {
      await loadUrl(win, EMPTY_CLASSROOM_APP);
      await waitForEhall(win);
      const result = await fetchEmptyClassrooms(client, {
        building: process.argv[4] ?? "",
        date: process.argv[5] ?? "",
        semesterCode: process.argv[6] ?? "",
        limit: 40,
      });
      publish(result);
      return;
    }
    if (mode === "card" || mode === "loans" || mode === "schoolnet" || mode === "forum" || mode === "attendance" || mode === "meters") {
      const urls = {
        card: CARD_LOGIN_URL,
        loans: LOAN_LOGIN_URL,
        schoolnet: SCHOOLNET_HOME_URL,
        forum: FORUM_URL,
        attendance: ATTENDANCE_LOGIN_URL,
        meters: METERS_LOGIN_URL,
      };
      const page = sessionPage(win);
      const result = await queryWhenReady(win, revealLogin, urls[mode], async () => {
        if (mode === "card") return fetchCampusCard(page);
        if (mode === "loans") return fetchLoans(page, await libraryJwt(win));
        if (mode === "schoolnet") return fetchSchoolnet(page);
        if (mode === "attendance") return fetchAttendance(page);
        if (mode === "meters") return fetchMeters(page);
        return fetchForum(page);
      });
      publish(result);
      return;
    }
    if (mode === "water") {
      publish(await runWater(win));
      return;
    }
    if (mode === "sport" || mode === "sportclass") {
      const saved = readSportSession();
      if (saved) {
        const cached = mode === "sportclass" ? await querySportClasses(saved) : await querySportScores(saved);
        if (cached.ok === true) {
          publish(cached);
          return;
        }
        clearSportSession();
      }
      const student = rememberedStudentId();
      if (!student) {
        publish({ ok: false, dataset: mode, error: "还没有学号。先用登录窗口完成一次统一认证。" });
        return;
      }
      win.show();
      await loadUrl(win, sportForm(student.slice(-4), mode === "sportclass" ? "体育课" : "体测"));
      const password = await waitForSportPassword(win);
      publish(await loginAndQuerySport(student, password, undefined, mode));
      return;
    }
    await loadUrl(win, classTableLoginUrl());
    await waitForEhall(win);
    studentId = studentId || await studentIdFromPage(win) || rememberedStudentId();
    if (studentId) rememberStudentId(studentId);
    const report = await syncEhall(client, studentId, dataDir);
    publish({
      ...report,
      ...(report.ok ? {} : { error: report.errors[0] ?? "登录成功，但没有同步到课表、成绩或考试。" }),
    });
  } catch (error) {
    publish({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function sessionPage(win: BrowserWindow): SessionPage {
  return {
    location: () => win.webContents.getURL(),
    evaluate: (expression) => win.webContents.executeJavaScript(expression),
    async request(url, init) {
      const response = await win.webContents.session.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return { status: response.status, text: await response.text() };
    },
  };
}

async function libraryJwt(win: BrowserWindow): Promise<string> {
  const fromUrl = jwtFromLocation(win.webContents.getURL());
  if (fromUrl) return fromUrl;
  const cookies = await win.webContents.session.cookies.get({ url: "https://mfindxidian.libsp.cn/" });
  return cookies.find((cookie) => cookie.name === "jwt")?.value ?? "";
}

async function queryWhenReady(
  win: BrowserWindow,
  reveal: () => void,
  url: string,
  query: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  await loadUrl(win, url);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error("窗口已关闭。");
    reveal();
    const result = await query();
    if (result.needsLogin === true) {
      win.show();
      await delay(1000);
      continue;
    }
    return result;
  }
  throw new Error("等待登录完成超时。");
}

function sportForm(suffix: string, title: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:sans-serif;padding:48px;background:#f6f4ef;color:#231c14">
<h1>${title}</h1>
<p>学号尾号 ${suffix}</p>
<p>这是体育系统的单独密码，只用于这一次查询，不会保存。</p>
<form id="sport">
<input id="pwd" type="password" autocomplete="current-password" placeholder="体育系统密码" style="font-size:16px;padding:8px">
<button type="submit" style="font-size:16px;padding:8px 16px">查询</button>
</form>
<script>
document.getElementById("sport").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("pwd");
  window.__xdyouSportPassword = input.value;
  input.value = "";
});
</script></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function waitForSportPassword(win: BrowserWindow): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待体测密码超时。")), 300_000);
    const poll = (): void => {
      if (win.isDestroyed()) {
        clearTimeout(timer);
        reject(new Error("窗口已关闭。"));
        return;
      }
      void win.webContents.executeJavaScript(`(() => {
        const value = typeof window.__xdyouSportPassword === "string" ? window.__xdyouSportPassword : "";
        window.__xdyouSportPassword = "";
        return value;
      })()`).then((value: unknown) => {
        if (typeof value === "string" && value.trim()) {
          clearTimeout(timer);
          resolve(value);
          return;
        }
        setTimeout(poll, 400);
      }).catch(() => setTimeout(poll, 400));
    };
    poll();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWater(win: BrowserWindow): Promise<Record<string, unknown>> {
  const saved = readWaterSession();
  if (saved) {
    const cached = await queryWater(saved);
    if (cached.ok === true) return cached;
    clearWaterSession();
  }
  win.show();
  await loadUrl(win, waterForm());
  let captcha = await fetchWaterCaptcha();
  await showWaterCaptcha(win, captcha.imageBase64);
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const step = await waitForWater(win, deadline - Date.now());
    if (step.action === "refresh") {
      captcha = await fetchWaterCaptcha();
      await showWaterCaptcha(win, captcha.imageBase64);
      await setWaterStatus(win, "验证码已更新。");
      continue;
    }
    if (step.action === "sms") {
      const sent = await sendWaterSms(captcha.sessionId, step.phone, step.imageCode);
      if (sent.ok !== true) {
        captcha = await fetchWaterCaptcha();
        await showWaterCaptcha(win, captcha.imageBase64);
        await setWaterStatus(win, typeof sent.error === "string" ? sent.error : "短信没有发出。");
        continue;
      }
      await setWaterStatus(win, "短信已发送。");
      continue;
    }
    const result = await loginAndQueryWater(step.phone, step.sms);
    if (result.ok === true) return result;
    await setWaterStatus(win, typeof result.error === "string" ? result.error : "登录没有成功。");
  }
  return { ok: false, dataset: "water", error: "等待宿舍水机登录超时。" };
}

function waterForm(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>宿舍水机</title>
<body style="font-family:sans-serif;padding:48px;background:#f6f4ef;color:#231c14">
<h1>宿舍水机</h1>
<p>验证码和短信只用于这一次登录，手机号和短信码不会保存。</p>
<img id="captcha" alt="验证码" style="height:64px;background:#fff">
<form id="water">
<p><input id="phone" inputmode="numeric" placeholder="手机号" style="font-size:16px;padding:8px"></p>
<p><input id="image" placeholder="图形验证码" style="font-size:16px;padding:8px">
<button id="send" type="button" style="font-size:16px;padding:8px 16px">发送短信</button>
<button id="refresh" type="button" style="font-size:16px;padding:8px 16px">换一张</button></p>
<p><input id="sms" inputmode="numeric" placeholder="短信验证码" style="font-size:16px;padding:8px">
<button id="query" type="button" style="font-size:16px;padding:8px 16px">查询</button></p>
</form>
<p id="status"></p>
<script>
const send = (action) => {
  const phone = document.getElementById("phone").value.trim();
  const imageCode = document.getElementById("image").value.trim();
  const sms = document.getElementById("sms").value.trim();
  window.__xdyouWater = { action, phone, imageCode, sms };
  document.getElementById("image").value = "";
  document.getElementById("sms").value = "";
};
document.getElementById("send").addEventListener("click", () => send("sms"));
document.getElementById("refresh").addEventListener("click", () => send("refresh"));
document.getElementById("query").addEventListener("click", () => send("login"));
</script></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function showWaterCaptcha(win: BrowserWindow, imageBase64: string): Promise<void> {
  const src = JSON.stringify(`data:image/png;base64,${imageBase64}`);
  await win.webContents.executeJavaScript(`document.getElementById("captcha").src = ${src}`);
}

async function setWaterStatus(win: BrowserWindow, message: string): Promise<void> {
  await win.webContents.executeJavaScript(`document.getElementById("status").textContent = ${JSON.stringify(message)}`);
}

function waitForWater(win: BrowserWindow, timeoutMs: number): Promise<{ action: string; phone: string; imageCode: string; sms: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待宿舍水机登录超时。")), timeoutMs);
    const poll = (): void => {
      if (win.isDestroyed()) {
        clearTimeout(timer);
        reject(new Error("窗口已关闭。"));
        return;
      }
      void win.webContents.executeJavaScript(`(() => {
        const value = window.__xdyouWater;
        window.__xdyouWater = null;
        return value || null;
      })()`).then((value: unknown) => {
        const step = value && typeof value === "object" ? value as { action?: unknown; phone?: unknown; imageCode?: unknown; sms?: unknown } : null;
        const action = typeof step?.action === "string" ? step.action : "";
        if (action === "refresh" || action === "sms" || action === "login") {
          clearTimeout(timer);
          resolve({
            action,
            phone: typeof step?.phone === "string" ? step.phone : "",
            imageCode: typeof step?.imageCode === "string" ? step.imageCode : "",
            sms: typeof step?.sms === "string" ? step.sms : "",
          });
          return;
        }
        setTimeout(poll, 400);
      }).catch(() => setTimeout(poll, 400));
    };
    poll();
  });
}

async function loadUrl(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
  }
}

function rememberedStudentId(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "account.json"), "utf8")) as { studentId?: unknown };
    return validStudentId(parsed.studentId);
  } catch {
    return "";
  }
}

function rememberStudentId(id: string): void {
  writeFileSync(join(dataDir, "account.json"), JSON.stringify({ studentId: id }), "utf8");
}

async function studentIdFromPage(win: BrowserWindow): Promise<string> {
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const text = document.body ? document.body.innerText : "";
      const match = text.match(/学号[^0-9A-Za-z]{0,12}([0-9A-Za-z]{4,32})/);
      return match ? match[1] : "";
    })()`);
    return validStudentId(value);
  } catch {
    return "";
  }
}

function validStudentId(value: unknown): string {
  return typeof value === "string" && /^[0-9A-Za-z]{4,32}$/.test(value) ? value : "";
}

function waitForEhall(win: BrowserWindow): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待统一认证完成超时。")), 180_000);
    const check = () => {
      if (win.isDestroyed()) {
        clearTimeout(timer);
        reject(new Error("登录窗口已关闭。"));
        return;
      }
      let current: URL;
      try {
        current = new URL(win.webContents.getURL());
      } catch {
        return;
      }
      if (current.hostname === "ehall.xidian.edu.cn") {
        clearTimeout(timer);
        win.webContents.removeListener("did-navigate", check);
        win.webContents.removeListener("did-navigate-in-page", check);
        win.webContents.removeListener("did-finish-load", check);
        resolve();
      }
    };
    win.webContents.on("did-navigate", check);
    win.webContents.on("did-navigate-in-page", check);
    win.webContents.on("did-finish-load", check);
    check();
  });
}

void main().catch((error: unknown) => {
  publish({ ok: false, error: error instanceof Error ? error.message : String(error) });
});

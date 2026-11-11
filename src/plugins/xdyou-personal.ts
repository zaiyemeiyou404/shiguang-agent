import { createHash, createPublicKey, publicEncrypt, constants } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

export const CARD_LOGIN_URL = "https://v8scan.xidian.edu.cn/home/openXDOAuth2Page";
export const LOAN_LOGIN_URL = "https://tyrzfw.chaoxing.com/auth/xidian/cas/init?isLogout=0&refer=https%3A%2F%2Fmfindxidian.libsp.cn%2Ffind%2Fsso%2Flogin%2Fxidian%2F1";
export const SCHOOLNET_HOME_URL = "https://zfw.xidian.edu.cn/home";
export const FORUM_URL = "https://rs.xidian.edu.cn/forum.php?mod=guide&view=hot";
const SPORT_LOGIN_URL = "https://tybjxgl.xidian.edu.cn/h5/login";
const SPORT_SCORE_URL = "https://tybjxgl.xidian.edu.cn/app/measure/getStuTotalScore";
const SPORT_DETAIL_URL = "https://tybjxgl.xidian.edu.cn/app/measure/getStuScoreDetail";
const SPORT_CLASS_URL = "https://tybjxgl.xidian.edu.cn/app/stuTermScore/uidSelect";
const SPORT_CURRICULUM_URL = "https://tybjxgl.xidian.edu.cn/app/stuTeacherCurriculum/selstuTeacherCurriculum";
const SPORT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq4l
aolA7zAk7jzsqDb3Oa5pS/uCPlZfASK8Soh/NzEmry77QDZ
2koyr96M5Wx+A9cxwewQMHzi8RoOfb3UcQO4UDQlMUImLuz
Unfbk3TTppijSLH+PU88XQxcgYm2JTa546c7JdZSI6dBeXO
JH20quuxWyzgLk9jAlt3ytYygPQ7C6o6ZSmjcMgE3xgLaHG
vixEVpOjL/pdVLzXhrMqWVAnB/snMjpCqesDVTDe5c6OOmj
2q5J8n+tzIXtnvrkxQSDaUp8DWF8meMwyTErmYklMXzKic2
rjdYZpHh4x98Fg0Q28sp6i2ZoWiGrJDKW29mntVQQiDNhKD
awb4B45zUwIDAQAB
-----END PUBLIC KEY-----`;

export interface SessionPage {
  location(): string;
  evaluate(expression: string): Promise<unknown>;
  request(url: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }>;
}

export function sportSign(params: Record<string, string>): string {
  const body = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
  return createHash("md5").update(body).digest("hex");
}

export function jwtFromLocation(location: string): string {
  try {
    const url = new URL(location);
    const direct = url.searchParams.get("jwt");
    if (direct) return direct;
    const hash = url.hash.replace(/^#/, "");
    const query = hash.indexOf("?");
    if (query < 0) return "";
    return new URLSearchParams(hash.slice(query + 1)).get("jwt") ?? "";
  } catch {
    return "";
  }
}

export function groupCodeFromJwt(jwt: string): string {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { groupCode?: unknown };
    return typeof parsed.groupCode === "string" && parsed.groupCode.trim() ? parsed.groupCode.trim() : "200755";
  } catch {
    return "200755";
  }
}

export function projectCardBalance(html: string): string {
  const item = html.match(/<li\b[^>]*>([\s\S]*?)<\/li>/i)?.[1] ?? "";
  const nested = innerHtml(topLevelChildren(innerHtml(topLevelChildren(item)[1] ?? ""))[1] ?? "");
  const money = nested.replace(/<[^>]+>/g, "").trim();
  if (money) return money;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return text.match(/余额[^0-9]{0,16}(\d+\.\d{2})/)?.[1] ?? "";
}

export function projectCardTrades(payload: unknown): Array<{ place: string; date: string; amount: string }> {
  const rows = asRecord(payload)?.resultData;
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 20).map((row) => {
    const item = asRecord(row) ?? {};
    return {
      place: text(item.mername),
      date: text(item.txdate),
      amount: text(item.txamt),
    };
  }).filter((row) => row.place || row.date || row.amount);
}

export function projectLoans(payload: unknown): Array<Record<string, unknown>> | null {
  const data = asRecord(asRecord(payload)?.data);
  const rows = data?.searchResult;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, 30).map((row) => {
    const item = asRecord(row) ?? {};
    return {
      title: text(item.title),
      author: text(item.author),
      loanDate: text(item.loanDate),
      dueDate: text(item.normReturnDate),
      location: text(item.locationName),
      renewTimes: finite(item.renewTimes),
    };
  }).filter((row) => row.title || row.author);
}

export function projectSchoolnet(html: string): Record<string, unknown> {
  const devices: Array<{ ip: string; online: string; traffic: string }> = [];
  let used = "";
  let rest = "";
  let charged = "";
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => (match[1] ?? "").replace(/<[^>]+>/g, "").trim());
    const traffic = cells[3] ?? "";
    if (cells.length === 7 && traffic) {
      devices.push({ ip: cells[1] ?? "", online: cells[2] ?? "", traffic });
    } else if (cells.length === 4 && !/联通|移动|电信/.test(cells[0] ?? "")) {
      used = cells[1] ?? "";
      rest = cells[2] ?? "";
      charged = cells[3] ?? "";
    }
  }
  return {
    ok: true,
    dataset: "schoolnet",
    used,
    rest,
    charged,
    devices: devices.slice(0, 10),
    count: devices.length,
  };
}

export function projectForum(html: string): Record<string, unknown> {
  if (/校外|非校园网|只能在校园网/.test(html)) {
    return { ok: false, dataset: "forum", error: "睿思只能在校园网内访问。" };
  }
  const threads: Array<{ title: string; tid: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/forum\.php\?mod=viewthread[^"'#]*tid=(\d+)[^"'#]*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const tid = match[1] ?? "";
    const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (!tid || !title || seen.has(tid)) continue;
    seen.add(tid);
    threads.push({ tid, title });
    if (threads.length >= 12) break;
  }
  if (threads.length === 0 && /member\.php\?mod=logging|action=login/i.test(html)) {
    return { ok: false, dataset: "forum", needsLogin: true, error: "睿思还需要登录。" };
  }
  return { ok: true, dataset: "forum", count: threads.length, threads };
}

export async function fetchCampusCard(page: SessionPage): Promise<Record<string, unknown>> {
  const host = hostname(page.location());
  if (host !== "v8scan.xidian.edu.cn") return { ok: false, dataset: "card", needsLogin: true, error: "校园卡还需要完成统一认证。" };
  const openid = text(await page.evaluate(`(() => {
    const element = document.querySelector('#openid');
    return element && "value" in element ? String(element.value) : "";
  })()`));
  if (!openid) return { ok: false, dataset: "card", error: "校园卡页面没有进入账户。" };
  try {
    const account = await page.request(`https://v8scan.xidian.edu.cn/myaccount/openMyAccount?openid=${encodeURIComponent(openid)}`, { method: "GET" });
    const end = shanghaiDate(0);
    const begin = shanghaiDate(-30);
    const trades = await page.request(`https://v8scan.xidian.edu.cn/selftrade/queryCardSelfTradeList?openid=${encodeURIComponent(openid)}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ beginDate: begin, endDate: end, tradeType: "-1", openid }),
    });
    const balance = projectCardBalance(account.text);
    const recent = projectCardTrades(parseJson(trades.text));
    if (!balance && recent.length === 0) return { ok: false, dataset: "card", error: "校园卡页面没有余额或交易记录。" };
    return { ok: true, dataset: "card", balance, recent, recentCount: recent.length };
  } catch (error) {
    return { ok: false, dataset: "card", error: hideSecret(error instanceof Error ? error.message : String(error), openid) };
  }
}

export async function fetchLoans(page: SessionPage, jwt: string): Promise<Record<string, unknown>> {
  if (hostname(page.location()) !== "mfindxidian.libsp.cn") {
    return { ok: false, dataset: "loans", needsLogin: true, error: "个人借阅还需要完成统一认证。" };
  }
  if (!jwt) return { ok: false, dataset: "loans", needsLogin: true, error: "个人借阅还需要完成图书馆登录。" };
  const response = await page.request("https://mfindxidian.libsp.cn/find/loanInfo/loanList", {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=utf-8",
      referer: "https://mfindxidian.libsp.cn/",
      groupCode: groupCodeFromJwt(jwt),
      mappingPath: "",
      jwtOpacAuth: jwt,
    },
    body: JSON.stringify({ page: 1, rows: 30, searchType: 1, searchContent: "", sortType: 0, startDate: null, endDate: null }),
  });
  if (response.status >= 400) return { ok: false, dataset: "loans", error: `借阅接口返回 HTTP ${response.status}` };
  const parsed = parseJson(response.text);
  const loans = projectLoans(parsed);
  if (!loans) {
    const keys = asRecord(parsed) ? Object.keys(asRecord(parsed) ?? {}) : [];
    return { ok: false, dataset: "loans", error: "借阅接口没有返回书单。", responseKeys: keys };
  }
  return { ok: true, dataset: "loans", count: loans.length, loans };
}

export async function fetchSchoolnet(page: SessionPage): Promise<Record<string, unknown>> {
  const current = page.location();
  if (/login/i.test(current) || hostname(current) === "ids.xidian.edu.cn") {
    return { ok: false, dataset: "schoolnet", needsLogin: true, error: "校园网账号还需要登录。" };
  }
  const response = await page.request(SCHOOLNET_HOME_URL, { method: "GET" });
  if (/type=["']password["']/i.test(response.text)) {
    return { ok: false, dataset: "schoolnet", needsLogin: true, error: "校园网账号还需要登录。" };
  }
  if (response.status >= 400) return { ok: false, dataset: "schoolnet", error: `校园网账号页面返回 HTTP ${response.status}` };
  return projectSchoolnet(response.text);
}

export async function fetchForum(page: SessionPage): Promise<Record<string, unknown>> {
  const response = await page.request(FORUM_URL, { method: "GET" });
  if (response.status >= 400) return { ok: false, dataset: "forum", error: `睿思返回 HTTP ${response.status}` };
  return projectForum(response.text);
}

export function clearSportSession(): void {
  rmSync(join(syncedXdyouDataDir(), "sport-session.json"), { force: true });
}

export function readSportSession(): { userId: string; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(syncedXdyouDataDir(), "sport-session.json"), "utf8")) as { userId?: unknown; token?: unknown };
    if (typeof parsed.userId !== "string" || typeof parsed.token !== "string" || !parsed.userId || !parsed.token) return null;
    return { userId: parsed.userId, token: parsed.token };
  } catch {
    return null;
  }
}

export function projectSportClass(term: unknown, detail: unknown): Record<string, unknown> {
  const item = asRecord(term) ?? {};
  const classData = asRecord(detail) ?? {};
  return {
    term: text(classData.teacherCurriculumSysTermName),
    name: text(classData.teacherCurriculumTeachingCurriculumName),
    teacher: text(classData.teacherCurriculumSysUserName),
    time: text(classData.teacherCurriculumTeachingSchoolTimeName),
    place: text(classData.teacherCurriculumTeachingAddressName),
    score: text(item.score),
  };
}

export async function querySportClasses(session: { userId: string; token: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await sportPost(SPORT_CLASS_URL, session.token, {
    uid: session.userId,
    pageIndex: "1",
    pageSize: "20",
  }, signal);
  if (text(response.returnCode) !== "200" || !Array.isArray(response.data)) {
    return { ok: false, dataset: "sportclass", error: text(response.returnMsg) || "体育课没有返回。" };
  }
  const classes: Array<Record<string, unknown>> = [];
  for (const row of response.data.slice(0, 6)) {
    const item = asRecord(row) ?? {};
    const id = text(item.id);
    if (!id) continue;
    const detail = await sportPost(SPORT_CURRICULUM_URL, session.token, { stuid: session.userId, stuTermScoreid: id }, signal);
    const classData = Array.isArray(detail.data) ? detail.data[0] : null;
    const projected = projectSportClass(item, classData);
    if (projected.name || projected.term) classes.push(projected);
  }
  return { ok: true, dataset: "sportclass", count: classes.length, classes };
}

export async function loginAndQuerySport(studentId: string, password: string, signal?: AbortSignal, dataset: "sport" | "sportclass" = "sport"): Promise<Record<string, unknown>> {
  const encrypted = publicEncrypt(
    { key: createPublicKey(SPORT_PUBLIC_KEY), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password),
  ).toString("base64");
  const login = await sportPost(SPORT_LOGIN_URL, "", { uname: studentId, pwd: encrypted, openid: "" }, signal);
  if (text(login.returnCode) !== "200") {
    return { ok: false, dataset, error: text(login.returnMsg) || "体育系统登录没有成功。" };
  }
  const data = asRecord(login.data) ?? {};
  const userId = text(data.id);
  const token = text(data.token);
  if (!userId || !token) return { ok: false, dataset, error: "体育系统登录没有返回可用会话。" };
  writeFileSync(join(syncedXdyouDataDir(), "sport-session.json"), JSON.stringify({ userId, token }), "utf8");
  return dataset === "sportclass" ? querySportClasses({ userId, token }, signal) : querySportScores({ userId, token }, signal);
}

export async function querySportScores(session: { userId: string; token: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await sportPost(SPORT_SCORE_URL, session.token, { userId: session.userId }, signal);
  if (text(response.returnCode) !== "200" || !Array.isArray(response.data)) {
    return { ok: false, dataset: "sport", error: text(response.returnMsg) || "体测成绩没有返回。" };
  }
  let total = "";
  let gradeType = "";
  let rank = "";
  const years: Array<Record<string, unknown>> = [];
  for (const row of response.data) {
    const item = asRecord(row) ?? {};
    if ("graduationStatus" in item) {
      total = text(item.totalScore);
      gradeType = text(item.gradeType);
      rank = text(item.rank);
      continue;
    }
    const details = years.length === 0 && text(item.meaScoreId)
      ? await sportDetails(session.token, text(item.meaScoreId), signal)
      : [];
    years.push({
      year: text(item.year),
      totalScore: text(item.totalScore),
      rank: text(item.rank),
      gradeType: text(item.gradeType),
      ...(details.length > 0 ? { details } : {}),
    });
  }
  return { ok: true, dataset: "sport", total, gradeType, rank, years };
}

async function sportDetails(token: string, meaScoreId: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const response = await sportPost(SPORT_DETAIL_URL, token, { meaScoreId }, signal);
  if (!Array.isArray(response.data)) return [];
  return response.data.slice(0, 12).map((row) => {
    const item = asRecord(row) ?? {};
    return {
      name: text(item.examName),
      actual: text(item.actualScore),
      score: text(item.score),
      rank: text(item.rank),
    };
  }).filter((item) => item.name);
}

async function sportPost(url: string, token: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timestamp = Date.now().toString();
  const payload = { ...fields, timestamp };
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      channel: "H5",
      version: "99999",
      type: "0",
      token,
      timestamp,
      sign: sportSign(payload),
    },
    body: JSON.stringify(payload),
  });
  const parsed = parseJson(await response.text());
  return asRecord(parsed) ?? {};
}

function topLevelChildren(html: string): string[] {
  const children: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of html.matchAll(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        children.push(html.slice(start, index + token.length));
        start = -1;
      }
      continue;
    }
    if (token.endsWith("/>")) continue;
    if (depth === 0) start = index;
    depth += 1;
  }
  return children;
}

function innerHtml(element: string): string {
  return element.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
}

function shanghaiDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function hideSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("(hidden)") : message;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function finite(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolExecutionContext } from "../tools/types.js";
import { queryAirconLive } from "./xdyou-aircon.js";
import { queryCampusNetwork, searchLibrary } from "./xdyou-live.js";
import { openXdyouClassrooms, openXdyouLogin, openXdyouSession } from "./xdyou-login.js";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

const MAX_CACHE_BYTES = 1024 * 1024;
const DATASETS = ["status", "schedule", "exams", "scores", "electricity", "experiments", "aircon", "airconlive", "library", "network", "login", "classrooms", "card", "loans", "schoolnet", "forum", "sport", "sportclass", "attendance", "meters", "water"] as const;
type XdyouDataset = (typeof DATASETS)[number];

const CACHE_FILES = [
  "ClassTable.json",
  "UserClass.json",
  "exam.json",
  "scores.json",
  "EnergyInfo.json",
  "Electricity.json",
  "ElectricityHistory.json",
  "PhysicsExperiment.json",
  "OtherExperiment.json",
  "ExamFile.json",
  "AirconEnergyCache.json",
  "AirconEnergyHistory.json",
] as const;

const PERIOD_CLOCKS = [
  "08:30", "09:15",
  "09:20", "10:05",
  "10:25", "11:10",
  "11:15", "12:00",
  "14:00", "14:45",
  "14:50", "15:35",
  "15:55", "16:40",
  "16:45", "17:30",
  "19:00", "19:45",
  "19:50", "20:35",
  "20:40", "21:25",
];

const WEEKDAY_LABELS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SECRET_KEY = /password|passwd|cookie|token|fingerprint|secret|authorization/i;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

export function defaultXdyouDataDir(): string {
  const roaming = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
  return join(roaming, "io.github.benderblog.traintime_pda", "traintime_pda");
}

export async function queryXdyou(input: unknown, context?: ToolExecutionContext): Promise<Record<string, unknown>> {
  throwIfAborted(context?.signal);
  const request = normalizeRequest(input);
  const dataDir = resolveDataDir(request.dataDir);
  const date = request.date ?? shanghaiToday();
  switch (request.dataset) {
    case "status":
      return readStatus(dataDir);
    case "schedule":
      return readSchedule(dataDir, date, request);
    case "exams":
      return readExams(dataDir, date, request);
    case "scores":
      return readScores(dataDir, request);
    case "electricity":
      return readElectricity(dataDir);
    case "experiments":
      return readExperiments(dataDir, date, request);
    case "aircon":
      return readAircon(dataDir);
    case "airconlive":
      return queryAirconLive(request.query ?? "", dataDir, context?.signal);
    case "library":
      return searchLibrary(request.query ?? "", request.limit, context?.signal);
    case "network":
      return queryCampusNetwork(context?.signal);
    case "login":
      return openXdyouLogin(context?.signal);
    case "classrooms":
      return openXdyouClassrooms([request.building, request.query].filter(Boolean).join(" "), formatDate(date), semesterCode(dataDir), context?.signal);
    case "card":
    case "loans":
    case "schoolnet":
    case "forum":
    case "sport":
    case "sportclass":
    case "attendance":
    case "meters":
    case "water":
      return openXdyouSession(request.dataset, context?.signal);
    default:
      return unavailable(`Unknown dataset. Use one of: ${DATASETS.join(", ")}.`);
  }
}

interface XdyouRequest {
  dataset: XdyouDataset;
  date?: CalendarDate;
  week?: number;
  weekOffset: number;
  semester?: string;
  query?: string;
  building?: string;
  limit: number;
  dataDir?: string;
}

function normalizeRequest(input: unknown): XdyouRequest {
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const dataset = typeof obj.dataset === "string" ? obj.dataset.trim().toLowerCase() : "";
  if (!DATASETS.includes(dataset as XdyouDataset)) {
    throw new Error(`xdyou: dataset must be one of ${DATASETS.join(", ")}`);
  }
  const date = typeof obj.date === "string" && obj.date.trim() ? parseDate(obj.date.trim()) : undefined;
  const week = finiteInteger(obj.week);
  const weekOffset = finiteInteger(obj.weekOffset) ?? 0;
  if (Math.abs(weekOffset) > 8) throw new Error("xdyou: weekOffset must be between -8 and 8");
  return {
    dataset: dataset as XdyouDataset,
    ...(date ? { date } : {}),
    ...(week === undefined ? {} : { week }),
    weekOffset,
    ...(typeof obj.semester === "string" && obj.semester.trim() ? { semester: obj.semester.trim() } : {}),
    ...(typeof obj.query === "string" && obj.query.trim()
      ? { query: dataset === "classrooms" ? obj.query.trim() : obj.query.trim().toLowerCase() }
      : {}),
    ...(dataset === "classrooms" && typeof obj.building === "string" && obj.building.trim()
      ? { building: obj.building.trim() }
      : {}),
    limit: clamp(finiteInteger(obj.limit) ?? 40, 1, 80),
    ...(typeof obj.dataDir === "string" && obj.dataDir.trim() ? { dataDir: obj.dataDir.trim() } : {}),
  };
}

function readStatus(dataDir: string): Record<string, unknown> {
  const files = CACHE_FILES.map((name) => describeFile(dataDir, name));
  return {
    ok: true,
    dataset: "status",
    dataDir,
    cacheFiles: files,
    credentialsPresent: existsSync(join(dataDir, "cookie")),
    credentialsReadable: false,
    syncDir: syncedXdyouDataDir(),
    usingSyncedCache: dataDir === resolve(syncedXdyouDataDir()),
    liveQueries: ["library", "network"],
    loginSync: ["schedule", "exams", "scores", "classrooms", "card", "loans", "attendance", "meters"],
    sessionOnly: ["sport", "sportclass", "schoolnet", "forum", "water", "experiments_live"],
    note: "xdyou_login opens the Xidian login window and syncs 课表, 成绩, and 考试. 校园卡, 个人借阅, 考勤, and 水电 reuse that sign-in. 宿舍水机 uses a phone SMS login and does not store the phone number. 空调实时状态 reads the device already saved by XDYou and does not send control commands. The university password and the sport password are not stored.",
  };
}

function readSchedule(dataDir: string, date: CalendarDate, request: XdyouRequest): Record<string, unknown> {
  const table = readJsonFile(dataDir, "ClassTable.json");
  if (!table) return unavailable("ClassTable.json was not found. Call xdyou_login and sign in; the plugin will sync the classtable.");
  const root = asRecord(table.value);
  if (!root) return unavailable("ClassTable.json is not a JSON object.");
  const termStart = parseDate(typeof root.termStartDay === "string" ? root.termStartDay : "");
  if (!termStart) return unavailable("ClassTable.json has no termStartDay.");
  const shiftedStart = addDays(termStart, request.weekOffset * 7);
  const computedWeek = currentWeek(shiftedStart, date);
  const week = request.week ?? computedWeek;
  const semesterLength = finiteInteger(root.semesterLength) ?? 0;
  const schoolDetails = asRecords(root.classDetail);
  const embeddedUserDetails = asRecords(root.userDefinedDetail);
  const userFile = readJsonFile(dataDir, "UserClass.json");
  const userRoot = asRecord(userFile?.value);
  const userDetails = userRoot ? asRecords(userRoot.userDefinedDetail) : embeddedUserDetails;
  const schoolArrangements = asRecords(root.timeArrangement).filter((item) => item.source !== "user");
  const userArrangements = userRoot
    ? asRecords(userRoot.timeArrangement)
    : asRecords(root.timeArrangement).filter((item) => item.source === "user");

  const inWeek = [...schoolArrangements, ...userArrangements]
    .map((item) => projectClass(item, item.source === "user" ? userDetails : schoolDetails))
    .filter((item): item is ClassProjection => item !== null)
    .filter((item) => week >= 0 && item.weeks[week] === true)
    .filter((item) => !request.query || item.name.toLowerCase().includes(request.query))
    .sort((left, right) => left.day - right.day || left.start - right.start)
    .map(({ weeks: _weeks, ...item }) => item);
  const classes = inWeek.filter((item) => item.day === date.weekday);
  const days = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    label: WEEKDAY_LABELS[day] ?? "",
    classes: inWeek.filter((item) => item.day === day).slice(0, 12),
  }));

  return {
    ok: true,
    dataset: "schedule",
    date: formatDate(date),
    weekday: WEEKDAY_LABELS[date.weekday] ?? "",
    semesterCode: typeof root.semesterCode === "string" ? root.semesterCode : "",
    week,
    weekOffset: request.weekOffset,
    weekOffsetSource: "request-or-default",
    semesterLength,
    inSemester: week >= 0 && (semesterLength <= 0 || week < semesterLength),
    classes: classes.slice(0, request.limit),
    days,
    changes: projectChanges(asRecords(root.classChanges), date.weekday, week).slice(0, request.limit),
    truncated: classes.length > request.limit,
    cacheUpdatedAt: table.updatedAt,
  };
}

interface ClassProjection {
  name: string;
  teacher: string | null;
  classroom: string | null;
  day: number;
  start: number;
  stop: number;
  startClock: string;
  endClock: string;
  source: string;
  weeks: boolean[];
}

function projectClass(item: Record<string, unknown>, details: Record<string, unknown>[]): ClassProjection | null {
  const index = finiteInteger(item.index);
  const day = finiteInteger(item.day);
  const start = finiteInteger(item.start);
  const stop = finiteInteger(item.stop);
  const weeks = Array.isArray(item.week_list) ? item.week_list.map((value) => value === true) : [];
  if (index === undefined || day === undefined || start === undefined || stop === undefined) return null;
  const detail = details[index];
  const name = typeof detail?.name === "string" && detail.name.trim() ? detail.name : "未命名课程";
  return {
    name,
    teacher: typeof item.teacher === "string" ? item.teacher : null,
    classroom: typeof item.classroom === "string" ? item.classroom : null,
    day,
    start,
    stop,
    startClock: PERIOD_CLOCKS[(start - 1) * 2] ?? "",
    endClock: PERIOD_CLOCKS[(stop - 1) * 2 + 1] ?? "",
    source: typeof item.source === "string" ? item.source : "school",
    weeks,
  };
}

function projectChanges(changes: Record<string, unknown>[], weekday: number, week: number): Record<string, unknown>[] {
  return changes.flatMap((change) => {
    const originalWeek = finiteInteger(change.originalWeek);
    const newWeek = finiteInteger(change.newWeek);
    const originalHit = originalWeek === weekday && boolAt(change.originalAffectedWeeks, week);
    const newHit = newWeek === weekday && boolAt(change.newAffectedWeeks, week);
    if (!originalHit && !newHit) return [];
    return [{
      type: change.type ?? "",
      className: change.className ?? "",
      originalWeek,
      newWeek,
      originalClassroom: change.originalClassroom ?? null,
      newClassroom: change.newClassroom ?? null,
      appliesTo: originalHit && newHit ? "both" : originalHit ? "original" : "new",
    }];
  });
}

function readExams(dataDir: string, date: CalendarDate, request: XdyouRequest): Record<string, unknown> {
  const file = readJsonFile(dataDir, "exam.json") ?? readJsonFile(dataDir, "ExamFile.json");
  if (!file) return unavailable("exam.json was not found. Call xdyou_login and sign in; the plugin will sync exams.");
  const root = asRecord(file.value);
  if (!root) return unavailable("exam.json is not a JSON object.");
  const todayStamp = formatDate(date);
  const exams = asRecords(root.subject)
    .map((item) => {
      const start = typeof item.startTimeStr === "string" ? item.startTimeStr : "";
      return {
        subject: typeof item.subject === "string" ? item.subject : "",
        type: typeof item.typeStr === "string" ? item.typeStr : "",
        start: start && start !== "cancel_exam" ? start : null,
        end: typeof item.endTimeStr === "string" && item.endTimeStr !== "cancel_exam" ? item.endTimeStr : null,
        place: typeof item.place === "string" ? item.place : "",
        seat: typeof item.seat === "string" ? item.seat : null,
      };
    })
    .filter((item) => !request.query || item.subject.toLowerCase().includes(request.query));
  const upcoming = exams.filter((item) => !item.start || item.start.slice(0, 10) >= todayStamp);
  const earlier = exams.filter((item) => item.start && item.start.slice(0, 10) < todayStamp);
  return {
    ok: true,
    dataset: "exams",
    date: todayStamp,
    upcoming: upcoming.slice(0, request.limit),
    earlierCount: earlier.length,
    unscheduled: asRecords(root.toBeArranged)
      .map((item) => (typeof item.subject === "string" ? item.subject : ""))
      .filter(Boolean)
      .slice(0, request.limit),
    cacheUpdatedAt: file.updatedAt,
  };
}

function readScores(dataDir: string, request: XdyouRequest): Record<string, unknown> {
  const file = readJsonFile(dataDir, "scores.json");
  if (!file) return unavailable("scores.json was not found. Call xdyou_login and sign in; the plugin will sync scores.");
  if (!Array.isArray(file.value)) return unavailable("scores.json is not a JSON array.");
  const courses = file.value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const scoreTypeCode = finiteInteger(item.scoreTypeCode) ?? 0;
      const numeric = typeof item.score === "number" ? item.score : null;
      const passed = item.isPassedStr === "1" ? true : item.isPassedStr === "0" ? false : null;
      return {
        name: typeof item.name === "string" ? item.name : "",
        score: scoreTypeCode === 1 || scoreTypeCode === 2 || scoreTypeCode === 3 ? null : numeric,
        level: typeof item.level === "string" ? item.level : null,
        semesterCode: typeof item.semesterCode === "string" ? item.semesterCode : "",
        credit: typeof item.credit === "number" ? item.credit : 0,
        classStatus: typeof item.classStatus === "string" ? item.classStatus : "",
        classType: typeof item.classType === "string" ? item.classType : "",
        passed,
        scoreTypeCode,
      };
    })
    .filter((item) => !request.semester || item.semesterCode === request.semester)
    .filter((item) => !request.query || item.name.toLowerCase().includes(request.query));

  let passedCredits = 0;
  let weighted = 0;
  let weight = 0;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const course of courses) {
    if (course.passed === true) {
      passed += 1;
      passedCredits += course.credit;
    } else if (course.passed === false) failed += 1;
    else pending += 1;
    if (course.score !== null && course.credit > 0) {
      weighted += course.score * course.credit;
      weight += course.credit;
    }
  }

  return {
    ok: true,
    dataset: "scores",
    summary: {
      count: courses.length,
      passed,
      failed,
      pending,
      passedCredits: round1(passedCredits),
      numericWeightedAverage: weight > 0 ? round1(weighted / weight) : null,
    },
    courses: courses.slice(0, request.limit).map(({ scoreTypeCode: _scoreTypeCode, ...course }) => course),
    truncated: courses.length > request.limit,
    cacheUpdatedAt: file.updatedAt,
  };
}

function readElectricity(dataDir: string): Record<string, unknown> {
  const energy = readJsonFile(dataDir, "EnergyInfo.json");
  if (energy) {
    const root = asRecord(energy.value);
    const meters = asRecord(root?.electricityMeterList) ?? {};
    const water = asRecord(root?.waterMeterList) ?? {};
    return {
      ok: true,
      dataset: "electricity",
      source: "EnergyInfo.json",
      meters: Object.entries(meters).slice(0, 8).map(([meterId, value]) => {
        const info = asRecord(value);
        return {
          meterId,
          remain: info?.remain ?? null,
          fetchDay: info?.fetchDay ?? null,
        };
      }),
      waterMeterCount: Object.keys(water).length,
      recentHistory: summarizeHistory(readJsonFile(dataDir, "ElectricityHistory.json")?.value),
      cacheUpdatedAt: energy.updatedAt,
    };
  }

  const legacy = readJsonFile(dataDir, "Electricity.json");
  if (!legacy) return unavailable("EnergyInfo.json and Electricity.json were not found. Open XDYou and refresh electricity.");
  const root = asRecord(legacy.value);
  return {
    ok: true,
    dataset: "electricity",
    source: "Electricity.json",
    remain: root?.remain ?? null,
    owe: root?.owe ?? null,
    fetchDay: root?.fetchDay ?? null,
    recentHistory: summarizeHistory(readJsonFile(dataDir, "ElectricityHistory.json")?.value),
    cacheUpdatedAt: legacy.updatedAt,
  };
}

function readAircon(dataDir: string): Record<string, unknown> {
  const current = readJsonFile(dataDir, "AirconEnergyCache.json");
  const history = readJsonFile(dataDir, "AirconEnergyHistory.json");
  if (!current && !history) return unavailable("AirconEnergyCache.json was not found. Open XDYou and refresh the air conditioner page.");
  const info = asRecord(current?.value);
  return {
    ok: true,
    dataset: "aircon",
    imei: typeof info?.imei === "string" ? info.imei : null,
    electricAmount: info?.electricAmount ?? null,
    fetchTime: info?.fetchTime ?? null,
    stateTime: info?.stateTime ?? null,
    recentHistory: summarizeHistory(history?.value),
    cacheUpdatedAt: current?.updatedAt ?? history?.updatedAt ?? null,
  };
}

function summarizeHistory(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.slice(-8).flatMap((item) => {
      const row = asRecord(item);
      if (!row) return [];
      return [{ fetchDay: row.fetchDay ?? row.fetchTime ?? null, remain: row.remain ?? row.electricAmount ?? null }];
    });
  }
  const meters = asRecord(value);
  if (!meters) return [];
  return Object.entries(meters).slice(0, 8).flatMap(([meterId, readings]) => {
    const list = Array.isArray(readings) ? readings : [];
    const last = asRecord(list.at(-1));
    return [{ meterId, fetchDay: last?.fetchDay ?? null, remain: last?.remain ?? null, points: list.length }];
  });
}

function readExperiments(dataDir: string, date: CalendarDate, request: XdyouRequest): Record<string, unknown> {
  const physics = readJsonFile(dataDir, "PhysicsExperiment.json");
  const others = readJsonFile(dataDir, "OtherExperiment.json");
  if (!physics && !others) return unavailable("No experiment cache was found. Open XDYou and refresh experiments.");
  const todayStamp = formatDate(date);
  const items = [
    ...projectExperiments(physics?.value, "physics"),
    ...projectExperiments(others?.value, "others"),
  ].filter((item) => !request.query || item.name.toLowerCase().includes(request.query));
  const upcoming = items.filter((item) => item.ranges.some((range) => range.start.slice(0, 10) >= todayStamp) || item.ranges.length === 0);
  return {
    ok: true,
    dataset: "experiments",
    date: todayStamp,
    experiments: (upcoming.length > 0 ? upcoming : items).slice(0, request.limit),
    count: items.length,
    cacheUpdatedAt: physics?.updatedAt ?? others?.updatedAt ?? null,
  };
}

function projectExperiments(value: unknown, fallbackType: string): Array<{ name: string; type: string; classroom: string; teacher: string; ranges: Array<{ start: string; end: string }> }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    if (!row || typeof row.name !== "string") return [];
    const ranges = Array.isArray(row.timeRanges) ? row.timeRanges.flatMap((range) => {
      const record = asRecord(range);
      const start = typeof record?.$1 === "string" ? record.$1 : "";
      const end = typeof record?.$2 === "string" ? record.$2 : "";
      return start ? [{ start, end }] : [];
    }) : [];
    return [{
      name: row.name,
      type: typeof row.type === "string" ? row.type : fallbackType,
      classroom: typeof row.classroom === "string" ? row.classroom : "",
      teacher: typeof row.teacher === "string" ? row.teacher : "",
      ranges,
    }];
  });
}

interface CacheFile {
  value: unknown;
  updatedAt: string;
}

function readJsonFile(dataDir: string, name: string): CacheFile | null {
  if (!CACHE_FILES.includes(name as (typeof CACHE_FILES)[number])) {
    throw new Error("xdyou: refused a file outside the cache allowlist");
  }
  const filePath = assertInsideDataDir(dataDir, name);
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_CACHE_BYTES) {
    throw new Error(`xdyou: ${name} is larger than 1 MiB`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return { value: redact(parsed), updatedAt: stat.mtime.toISOString() };
}

function describeFile(dataDir: string, name: string): Record<string, unknown> {
  const filePath = assertInsideDataDir(dataDir, name);
  if (!existsSync(filePath)) return { name, exists: false };
  const stat = statSync(filePath);
  return {
    name,
    exists: stat.isFile(),
    bytes: stat.isFile() ? stat.size : 0,
    updatedAt: stat.mtime.toISOString(),
  };
}

function semesterCode(dataDir: string): string {
  const table = readJsonFile(dataDir, "ClassTable.json");
  const code = asRecord(table?.value)?.semesterCode;
  return typeof code === "string" ? code : "";
}

function syncedCacheReady(): boolean {
  const dir = syncedXdyouDataDir();
  return CACHE_FILES.some((name) => {
    const filePath = join(dir, name);
    return existsSync(filePath) && statSync(filePath).isFile();
  });
}

function resolveDataDir(override: string | undefined): string {
  const fromEnv = process.env.XDYOU_DATA_DIR?.trim();
  const chosen = override || fromEnv || (syncedCacheReady() ? syncedXdyouDataDir() : defaultXdyouDataDir());
  const resolved = resolve(chosen);
  if (!isAbsolute(resolved)) throw new Error("xdyou: data directory must be absolute");
  const segments = resolved.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  if (segments.includes("cookie") || segments.includes("shared_preferences.json")) {
    throw new Error("xdyou: refusing a cookie or preference directory");
  }
  return resolved;
}

function assertInsideDataDir(dataDir: string, name: string): string {
  if (name !== name.trim() || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("xdyou: invalid cache file name");
  }
  const filePath = resolve(dataDir, name);
  const rel = relative(dataDir, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("xdyou: cache path escaped the data directory");
  return filePath;
}

function unavailable(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = redact(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null);
}

function boolAt(value: unknown, index: number): boolean {
  return Array.isArray(value) && value[index] === true;
}

function finiteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseDate(value: string): CalendarDate | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day, weekday: weekdayOf(year, month, day) };
}

function shanghaiToday(now = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return { year, month, day, weekday: weekdayOf(year, month, day) };
}

function weekdayOf(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    weekday: weekdayOf(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate()),
  };
}

function currentWeek(start: CalendarDate, date: CalendarDate): number {
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const dateUtc = Date.UTC(date.year, date.month - 1, date.day);
  let delta = Math.floor((dateUtc - startUtc) / 86_400_000);
  if (delta < 0) delta = -7;
  return Math.floor(delta / 7);
}

function formatDate(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
}

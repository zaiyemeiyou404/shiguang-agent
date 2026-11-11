import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncedXdyouDataDir } from "./xdyou-paths.js";

const CLASS_TABLE_APP = "https://ehall.xidian.edu.cn/appShow?appId=4770397878132218";
const SCORE_APP = "https://ehall.xidian.edu.cn/appShow?appId=4768574631264620";
const EXAM_APP = "https://ehall.xidian.edu.cn/appShow?appId=4768687067472349";

export interface EhallClient {
  open(url: string): Promise<void>;
  post(url: string, fields?: Record<string, string>): Promise<unknown>;
}

export interface SyncReport {
  ok: boolean;
  dataDir: string;
  synced: string[];
  errors: string[];
  accountSuffix: string | null;
}

export async function syncEhall(client: EhallClient, studentId: string, dataDir = syncedXdyouDataDir()): Promise<SyncReport> {
  const synced: string[] = [];
  const errors: string[] = [];
  mkdirSync(dataDir, { recursive: true });

  let semester = "";
  try {
    semester = readSemester(await client.post(
      "https://ehall.xidian.edu.cn/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do",
    ));
  } catch (error) {
    errors.push(`课表学期：${messageOf(error)}`);
  }

  if (semester && studentId) {
    try {
      const parts = splitSemester(semester);
      const termStart = readTermStart(await client.post(
        "https://ehall.xidian.edu.cn/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do",
        { XN: parts.year, XQ: parts.term },
      ));
      if (!termStart) throw new Error("没有读到学期开始日期");
      const table = await client.post(
        "https://ehall.xidian.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do",
        { XNXQDM: semester, XH: studentId },
      );
      const notArranged = await client.post(
        "https://ehall.xidian.edu.cn/jwapp/sys/wdkb/modules/xskcb/cxxsllsywpk.do",
        { XNXQDM: semester, XH: studentId },
      );
      let changes: unknown = [];
      try {
        changes = await client.post(
          "https://ehall.xidian.edu.cn/jwapp/sys/wdkb/modules/xskcb/xsdkkc.do",
          { XNXQDM: semester, "*order": "-SQSJ" },
        );
      } catch {
        changes = [];
      }
      writeJson(dataDir, "ClassTable.json", projectClassTable(semester, termStart, table, notArranged, changes));
      synced.push("schedule");
    } catch (error) {
      errors.push(`课表：${messageOf(error)}`);
    }
  } else if (semester && !studentId) {
    errors.push("课表：登录页没有读到学号，请在账号框输入学号后再登录。");
  }

  try {
    await client.open(SCORE_APP);
    const scores = await client.post(
      "https://ehall.xidian.edu.cn/jwapp/sys/cjcx/modules/cjcx/xscjcx.do",
      {
        "*json": "1",
        querySetting: JSON.stringify({ name: "SFYX", value: "1", linkOpt: "and", builder: "m_value_equal" }),
        "*order": "+XNXQDM,KCH,KXH",
        pageSize: "1000",
        pageNumber: "1",
      },
    );
    writeJson(dataDir, "scores.json", projectScores(scores));
    synced.push("scores");
  } catch (error) {
    errors.push(`成绩：${messageOf(error)}`);
  }

  if (semester) {
    try {
      await client.open(EXAM_APP);
      const exams = await client.post(withQuery(
        "https://ehall.xidian.edu.cn/jwapp/sys/studentWdksapApp/modules/wdksap/wdksap.do",
        { XNXQDM: semester, "*order": "-KSRQ,-KSSJMS" },
      ));
      const pending = await client.post(withQuery(
        "https://ehall.xidian.edu.cn/jwapp/sys/studentWdksapApp/modules/wdksap/cxyxkwapkwdkc.do",
        { XNXQDM: semester },
      ));
      writeJson(dataDir, "exam.json", projectExams(exams, pending));
      synced.push("exams");
    } catch (error) {
      errors.push(`考试：${messageOf(error)}`);
    }
  }

  return {
    ok: synced.length > 0,
    dataDir,
    synced,
    errors,
    accountSuffix: studentId.length >= 4 ? studentId.slice(-4) : null,
  };
}

export function classTableLoginUrl(): string {
  return `https://ids.xidian.edu.cn/authserver/login?service=${encodeURIComponent(CLASS_TABLE_APP)}`;
}

export function projectClassTable(
  semesterCode: string,
  termStartDay: string,
  tablePayload: unknown,
  notArrangedPayload: unknown,
  changePayload: unknown,
): Record<string, unknown> {
  const table = nested(tablePayload, ["datas", "xskcb"]);
  const published = codeOf(table);
  const rows = published === 1 ? rowsOf(table) : [];
  const details: Array<{ name: string; code: string; number: string }> = [];
  const arrangements: Array<Record<string, unknown>> = [];
  let semesterLength = 1;
  for (const row of rows) {
    const name = text(row.KCM);
    const code = text(row.KCH);
    const number = text(row.KXH);
    if (!name) continue;
    let index = details.findIndex((item) => item.code === code && item.number === number && item.name === name);
    if (index < 0) {
      details.push({ name, code, number });
      index = details.length - 1;
    }
    const weeks = weekBits(row.SKZC);
    semesterLength = Math.max(semesterLength, weeks.length);
    const start = intField(row.KSJC);
    const stop = intField(row.JSJC);
    const day = intField(row.SKXQ);
    if (start === null || stop === null || day === null) continue;
    arrangements.push({
      index,
      week_list: weeks,
      teacher: text(row.SKJS) || null,
      day,
      start,
      stop,
      source: "school",
      classroom: text(row.JASMC) || null,
    });
  }
  const notArranged = rowsOf(nested(notArrangedPayload, ["datas", "cxxsllsywpk"])).flatMap((row) => {
    const name = text(row.KCM);
    if (!name) return [];
    return [{ name, code: text(row.KCH) || null, number: text(row.KXH) || null, teacher: text(row.SKJS) || null }];
  });
  const changeRoot = nested(changePayload, ["datas", "xsdkkc"]);
  const classChanges = codeOf(changeRoot) === 1 ? rowsOf(changeRoot).flatMap((row) => {
    const className = text(row.KCM);
    const classCode = text(row.KCH);
    if (!className || !classCode) return [];
    return [{
      type: changeType(text(row.TKLXDM)),
      classCode,
      classNumber: text(row.KXH),
      className,
      originalAffectedWeeks: weekBits(row.SKZC),
      newAffectedWeeks: weekBits(row.XSKZC),
      originalTeacherData: text(row.YSKJS) || null,
      newTeacherData: text(row.XSKJS) || null,
      originalClassRange: [intField(row.KSJC) ?? -1, intField(row.JSJC) ?? -1],
      newClassRange: [intField(row.XKSJC) ?? -1, intField(row.XJSJC) ?? -1],
      originalWeek: intField(row.SKXQ),
      newWeek: intField(row.XSKXQ),
      originalClassroom: text(row.JASMC) || null,
      newClassroom: text(row.XJASMC) || null,
    }];
  }) : [];
  return {
    semesterLength,
    semesterCode,
    termStartDay,
    classDetail: details,
    notArranged,
    timeArrangement: arrangements,
    classChanges,
  };
}

export function projectScores(payload: unknown): Array<Record<string, unknown>> {
  const root = nested(payload, ["datas", "xscjcx"]);
  if (codeOf(root) !== 1) throw new Error(text(record(root)?.extParams && record(record(root)?.extParams)?.msg) || "成绩接口没有返回数据");
  return rowsOf(root).flatMap((row, mark) => {
    const name = text(row.XSKCM);
    if (!name) return [];
    const elective = text(row.XGXKLBDM_DISPLAY);
    const scoreTypeCode = intField(row.DJCJLXDM) ?? 0;
    return [{
      mark,
      name,
      score: numberField(row.ZCJ),
      semesterCode: text(row.XNXQDM),
      credit: numberField(row.XF) ?? 0,
      classStatus: elective ? `选修 ${elective}` : text(row.KCXZDM_DISPLAY),
      classType: text(row.KCLBDM_DISPLAY),
      scoreStatus: text(row.CXCKDM_DISPLAY),
      scoreTypeCode,
      level: text(row.DJCJMC) || null,
      isPassedStr: row.SFJG === undefined || row.SFJG === null ? null : String(row.SFJG),
      classID: text(row.JXBID) || null,
    }];
  });
}

export function projectExams(payload: unknown, pendingPayload: unknown): Record<string, unknown> {
  const root = nested(payload, ["datas", "wdksap"]);
  if (record(payload)?.code !== undefined && String(record(payload)?.code) !== "0") {
    throw new Error(text(record(root)?.extParams && record(record(root)?.extParams)?.msg) || "考试接口没有返回数据");
  }
  const subject = rowsOf(root).flatMap((row) => {
    const name = text(row.KCM);
    if (!name) return [];
    const time = text(row.KSSJMS) || "未知考试时间";
    const range = examRange(time);
    return [{
      subject: name,
      typeStr: text(row.KSMC) || "未知类型考试",
      time,
      place: text(row.JASMC) || "尚无安排",
      seat: text(row.ZWH) || null,
      startTimeStr: range.start,
      endTimeStr: range.end,
    }];
  });
  const pendingRoot = nested(pendingPayload, ["datas", "cxyxkwapkwdkc"]);
  const toBeArranged = rowsOf(pendingRoot).flatMap((row) => {
    const name = text(row.KCM);
    if (!name) return [];
    return [{ subject: name, id: text(row.KCH) }];
  });
  return { subject, toBeArranged };
}

function readSemester(payload: unknown): string {
  const row = rowsOf(nested(payload, ["datas", "dqxnxq"]))[0];
  const semester = text(row?.DM);
  if (!semester) throw new Error("没有读到当前学期");
  return semester;
}

function readTermStart(payload: unknown): string {
  const row = rowsOf(nested(payload, ["datas", "cxjcs"]))[0];
  return text(row?.XQKSRQ);
}

function splitSemester(semester: string): { year: string; term: string } {
  const parts = semester.split("-");
  const year = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : semester;
  return { year, term: parts[2] ?? "1" };
}

function writeJson(dataDir: string, name: string, value: unknown): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 1024 * 1024) throw new Error(`${name} 超过 1 MiB，没有写入`);
  writeFileSync(join(dataDir, name), body, "utf8");
}

function withQuery(url: string, fields: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
  return target.toString();
}

function nested(payload: unknown, path: string[]): unknown {
  let current = payload;
  for (const key of path) {
    const recordValue = record(current);
    current = recordValue ? recordValue[key] : undefined;
  }
  return current;
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  const rows = record(payload)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    const row = record(item);
    return row ? [row] : [];
  });
}

function codeOf(payload: unknown): number | null {
  return intField(record(record(payload)?.extParams)?.code);
}

function changeType(code: string): "change" | "stop" | "patch" {
  if (code === "01") return "change";
  if (code === "02") return "stop";
  return "patch";
}

function weekBits(value: unknown): boolean[] {
  return [...text(value)].map((bit) => bit === "1");
}

function examRange(time: string): { start: string; end: string } {
  const match = time.match(/^(?<year>\d+)-(?<month>\d+)-(?<day>\d+) (?<hour>\d+):+?(?<minute>\d+)-(?<stopHour>\d+):+?(?<stopMinute>\d+)/);
  if (!match?.groups) return { start: "cancel_exam", end: "cancel_exam" };
  const stamp = (hour: string, minute: string) => {
    const year = match.groups?.year ?? "";
    const month = (match.groups?.month ?? "").padStart(2, "0");
    const day = (match.groups?.day ?? "").padStart(2, "0");
    return `${year}-${month}-${day} ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`;
  };
  return {
    start: stamp(match.groups.hour ?? "", match.groups.minute ?? ""),
    end: stamp(match.groups.stopHour ?? "", match.groups.stopMinute ?? ""),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function intField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

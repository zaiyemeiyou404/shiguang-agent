import type { EhallClient } from "./xdyou-sync.js";

export const EMPTY_CLASSROOM_APP = "https://ehall.xidian.edu.cn/appShow?appId=4768402106681759";

const BUILDING_URL = "https://ehall.xidian.edu.cn/jwapp/sys/kxjas/modules/kxjas/jxlcx.do";
const DATE_URL = "https://ehall.xidian.edu.cn/jwapp/sys/kxjas/modules/kxjas/rqzhzcjc.do";
const ROOM_URL = "https://ehall.xidian.edu.cn/jwapp/sys/kxjas/modules/kxjas/cxjsqk.do";

const PERIODS: Array<[number, string, string]> = [
  [1, "08:30", "09:15"],
  [2, "09:20", "10:05"],
  [3, "10:25", "11:10"],
  [4, "11:15", "12:00"],
  [5, "14:00", "14:45"],
  [6, "14:50", "15:35"],
  [7, "15:55", "16:40"],
  [8, "16:45", "17:30"],
  [9, "19:00", "19:45"],
  [10, "19:50", "20:35"],
  [11, "20:40", "21:25"],
];

export async function fetchEmptyClassrooms(
  client: EhallClient,
  input: { building: string; date: string; semesterCode: string; limit: number },
): Promise<Record<string, unknown>> {
  const buildings = projectBuildings(await client.post(BUILDING_URL, { "*order": "+XXXQDM,+PX,+JXLDM" }));
  const query = input.building.trim();
  if (!query) {
    return { ok: true, dataset: "classrooms", date: input.date, buildings, count: buildings.length };
  }
  const matches = buildings.filter((item) => item.name.includes(query) || item.code === query).slice(0, 3);
  if (matches.length === 0) {
    return { ok: false, dataset: "classrooms", error: `没有找到教学楼「${query}」。`, buildings };
  }
  if (!input.semesterCode) return { ok: false, dataset: "classrooms", error: "还没有学期信息。先登录并同步课表。" };
  const parts = input.semesterCode.split("-");
  const year = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : input.semesterCode;
  const term = parts[2] ?? "1";
  const rooms = [];
  for (const building of matches) {
    const converted = await client.post(DATE_URL, { RQ: input.date, XN: year, XQ: term });
    const root = nested(converted, ["datas", "rqzhzcjc"]);
    const week = text(record(root)?.ZC);
    const weekday = text(record(root)?.XQJ);
    if (!week || !weekday) throw new Error(`${building.name} 没有换算出周次。`);
    const payload = await client.post(ROOM_URL, {
      XNXQDM: input.semesterCode,
      ZC: week,
      XQ: weekday,
      querySetting: JSON.stringify([
        { name: "JXLDM", caption: "教学楼代码", builder: "equal", linkOpt: "AND", value: building.code },
        { name: "XNXQDM", value: input.semesterCode, linkOpt: "AND", builder: "equal" },
        { name: "ZC", value: week, linkOpt: "AND", builder: "equal" },
        { name: "ZC", value: weekday, linkOpt: "AND", builder: "equal" },
      ]),
      "*order": "+LC,+JASMC",
      pageSize: "999",
      pageNumber: "1",
    });
    rooms.push(...projectRooms(payload, building.name));
  }
  return {
    ok: true,
    dataset: "classrooms",
    date: input.date,
    semesterCode: input.semesterCode,
    building: matches.map((item) => item.name).join("、"),
    rooms: rooms.slice(0, input.limit),
    count: rooms.length,
    truncated: rooms.length > input.limit,
  };
}

export function projectBuildings(payload: unknown): Array<{ code: string; name: string }> {
  return rows(nested(payload, ["datas", "jxlcx"])).flatMap((row) => {
    const code = text(row.JXLDM);
    const name = text(row.JXLJC);
    return code && name ? [{ code, name }] : [];
  });
}

export function projectRooms(payload: unknown, building: string): Array<Record<string, unknown>> {
  return rows(nested(payload, ["datas", "cxjsqk"])).flatMap((row) => {
    const name = text(row.JASMC).replace(/[(（]/g, " ").replace(/[)）]/g, "").replace(/\s+/g, " ").trim();
    if (!name) return [];
    const free = PERIODS.flatMap(([period, start, end]) => {
      const value = text(row[`JC${period}`]);
      if (!value || value.includes("1_")) return [];
      return [{ period, start, end }];
    });
    if (free.length === 0) return [];
    return [{ building, name, free }];
  });
}

function rows(payload: unknown): Record<string, unknown>[] {
  const value = record(payload)?.rows;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    return row ? [row] : [];
  });
}

function nested(payload: unknown, path: string[]): unknown {
  let current = payload;
  for (const key of path) current = record(current)?.[key];
  return current;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

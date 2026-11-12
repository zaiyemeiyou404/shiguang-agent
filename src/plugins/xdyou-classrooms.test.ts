import { test } from "node:test";
import * as assert from "node:assert/strict";
import { classroomBuildingQuery, fetchEmptyClassrooms, projectBuildings, projectRooms } from "./xdyou-classrooms.js";

test("empty classroom projection keeps free periods and drops occupied rooms", () => {
  const buildings = projectBuildings({
    datas: { jxlcx: { rows: [{ JXLDM: "01", JXLJC: "B楼" }, { JXLDM: "", JXLJC: "缺代码" }] } },
  });
  assert.deepEqual(buildings, [{ code: "01", name: "B楼" }]);

  const rooms = projectRooms({
    datas: {
      cxjsqk: {
        rows: [
          { JASMC: "B-101(多媒体)", JC1: "0", JC5: "1_占用" },
          { JASMC: "B-102", JC1: "1_占用", JC2: "1_占用" },
        ],
      },
    },
  }, "B楼");
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0]?.name, "B-101 多媒体");
  assert.deepEqual(rooms[0]?.free, [{ period: 1, start: "08:30", end: "09:15" }]);
});

test("an empty-classroom request queries rooms instead of returning buildings", async () => {
  assert.equal(classroomBuildingQuery("空教室"), "");
  assert.equal(classroomBuildingQuery("教学楼"), "");
  assert.equal(classroomBuildingQuery("B楼空教室"), "B楼");

  const calls: string[] = [];
  const result = await fetchEmptyClassrooms({
    async open() {},
    async post(url: string, fields?: Record<string, string>) {
      calls.push(url);
      if (url.endsWith("jxlcx.do")) {
        return { datas: { jxlcx: { rows: [{ JXLDM: "01", JXLJC: "B楼" }, { JXLDM: "02", JXLJC: "A楼" }] } } };
      }
      if (url.endsWith("rqzhzcjc.do")) return { datas: { rqzhzcjc: { ZC: "10", XQJ: "4" } } };
      const setting = JSON.parse(fields?.querySetting ?? "[]") as Array<{ value?: string }>;
      const code = setting[0]?.value;
      return { datas: { cxjsqk: { rows: [{ JASMC: code === "01" ? "B-101" : "A-201", JC1: "0" }] } } };
    },
  }, { building: "空教室", date: "2026-11-12", semesterCode: "2026-2027-1", limit: 40 });

  assert.equal(calls.filter((url) => url.endsWith("cxjsqk.do")).length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.buildings, undefined);
  assert.deepEqual((result.rooms as Array<{ name: string }>).map((room) => room.name), ["B-101", "A-201"]);
});

test("a named building queries only that building's empty classrooms", async () => {
  const roomCodes: string[] = [];
  const result = await fetchEmptyClassrooms({
    async open() {},
    async post(url: string, fields?: Record<string, string>) {
      if (url.endsWith("jxlcx.do")) {
        return { datas: { jxlcx: { rows: [{ JXLDM: "01", JXLJC: "B楼" }, { JXLDM: "02", JXLJC: "A楼" }] } } };
      }
      if (url.endsWith("rqzhzcjc.do")) return { datas: { rqzhzcjc: { ZC: "10", XQJ: "4" } } };
      const setting = JSON.parse(fields?.querySetting ?? "[]") as Array<{ value?: string }>;
      roomCodes.push(setting[0]?.value ?? "");
      return { datas: { cxjsqk: { rows: [{ JASMC: "B-101", JC1: "0" }] } } };
    },
  }, { building: "B楼", date: "2026-11-12", semesterCode: "2026-2027-1", limit: 40 });

  assert.deepEqual(roomCodes, ["01"]);
  assert.equal(result.building, "B楼");
});

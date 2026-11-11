import { test } from "node:test";
import * as assert from "node:assert/strict";
import { projectBuildings, projectRooms } from "./xdyou-classrooms.js";

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

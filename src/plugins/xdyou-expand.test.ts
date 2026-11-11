import assert from "node:assert/strict";
import test from "node:test";
import { projectAirconState } from "./xdyou-aircon.js";
import { projectMeters } from "./xdyou-meters.js";
import { projectWater } from "./xdyou-water.js";

test("water, meter, and aircon projections drop credentials and device secrets", () => {
  const water = projectWater({
    code: 0,
    data: {
      account: { balance: "12.5", phone: "13800000000", token: "secret" },
      favos: [{ id: "device-secret", name: "1号水机" }],
    },
  });
  assert.equal(water.ok, true);
  assert.deepEqual(water.devices, [{ name: "1号水机" }]);
  assert.deepEqual(water.balance, { balance: "12.5" });
  assert.equal(JSON.stringify(water).includes("13800000000"), false);
  assert.equal(JSON.stringify(water).includes("secret"), false);

  assert.deepEqual(projectMeters("宿舍电表\n剩余 18.2 度\n姓名 席某"), {
    ok: true,
    dataset: "meters",
    lines: ["剩余 18.2 度"],
  });
  assert.equal(projectMeters("请连接校园网后再试").error, "水电查询只能在校园网内使用。");

  const aircon = projectAirconState({
    success: true,
    result: { imei: "123456789012345", switchStatus: 1, runMode: 2, windSpeed: 3, tempSet: 26, indoorTemp: 27.5, electricAmount: 8.2, timestamp: 1760000000 },
  });
  assert.equal(aircon.on, true);
  assert.equal(aircon.mode, "制冷");
  assert.equal(aircon.deviceSuffix, "2345");
  assert.equal(JSON.stringify(aircon).includes("123456789012345"), false);
});

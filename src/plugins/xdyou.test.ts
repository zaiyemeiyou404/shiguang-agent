import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { xdyouPlugin } from "./xdyou-plugin.js";
import { createPluginTools } from "./tool-adapter.js";

function xdyouTool(capability: string) {
  const tool = createPluginTools(xdyouPlugin).find((item) => item.descriptor.name === `xdyou_${capability}`);
  if (!tool) throw new Error(`missing xdyou capability: ${capability}`);
  return tool;
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "xdyou-cache-"));
}

test("xdyou plugin reads Monday classes from the local cache", async () => {
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "ClassTable.json"), JSON.stringify({
      semesterLength: 16,
      semesterCode: "2025-2026-1",
      termStartDay: "2025-09-01",
      classDetail: [{ name: "操作系统", code: "CS001" }],
      timeArrangement: [{
        index: 0,
        week_list: Array(16).fill(true),
        teacher: "张老师",
        day: 1,
        start: 1,
        stop: 2,
        source: "school",
        classroom: "A-101",
      }],
      classChanges: [],
    }));
    const result = await xdyouTool("schedule").execute({
      date: "2025-09-01",
      dataDir: dir,
    }) as { ok: boolean; classes: Array<{ name: string; startClock: string; endClock: string; classroom: string }> };
    assert.equal(result.ok, true);
    assert.equal(result.classes.length, 1);
    assert.equal(result.classes[0]?.name, "操作系统");
    assert.equal(result.classes[0]?.startClock, "08:30");
    assert.equal(result.classes[0]?.endClock, "10:05");
    assert.equal(result.classes[0]?.classroom, "A-101");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xdyou plugin summarizes scores and skips another weekday", async () => {
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "scores.json"), JSON.stringify([
      { name: "高等数学", score: 90, semesterCode: "2024-2025-1", credit: 4, classStatus: "必修", classType: "学科基础", scoreTypeCode: 0, isPassedStr: "1" },
      { name: "体育", score: null, semesterCode: "2024-2025-1", credit: 1, classStatus: "必修", classType: "公共", scoreTypeCode: 1, level: "优秀", isPassedStr: "1" },
      { name: "未出分课程", score: null, semesterCode: "2024-2025-1", credit: 2, classStatus: "选修", classType: "选修", scoreTypeCode: 0, isPassedStr: null },
    ]));
    const scores = await xdyouTool("scores").execute({ dataDir: dir }) as {
      summary: { count: number; passed: number; pending: number; passedCredits: number; numericWeightedAverage: number | null };
    };
    assert.equal(scores.summary.count, 3);
    assert.equal(scores.summary.passed, 2);
    assert.equal(scores.summary.pending, 1);
    assert.equal(scores.summary.passedCredits, 5);
    assert.equal(scores.summary.numericWeightedAverage, 90);

    writeFileSync(join(dir, "ClassTable.json"), JSON.stringify({
      semesterLength: 16,
      semesterCode: "2025-2026-1",
      termStartDay: "2025-09-01",
      classDetail: [{ name: "操作系统" }],
      timeArrangement: [{ index: 0, week_list: Array(16).fill(true), day: 1, start: 1, stop: 2, source: "school" }],
    }));
    const tuesday = await xdyouTool("schedule").execute({
      date: "2025-09-02",
      dataDir: dir,
    }) as { classes: unknown[] };
    assert.equal(tuesday.classes.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xdyou plugin refuses cookie directories and does not return secrets", async () => {
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "cookie"));
    writeFileSync(join(dir, "cookie", "session.json"), JSON.stringify({ password: "should-not-leak", cookie: "abc" }));
    writeFileSync(join(dir, "ClassTable.json"), JSON.stringify({
      semesterLength: 1,
      termStartDay: "2025-09-01",
      classDetail: [{ name: "编译原理" }],
      idsPassword: "stored-secret",
      timeArrangement: [{ index: 0, week_list: [true], day: 1, start: 3, stop: 4, source: "school" }],
    }));
    await assert.rejects(
      () => xdyouTool("status").execute({ dataDir: join(dir, "cookie") }),
      /refusing a cookie/i,
    );
    const result = await xdyouTool("schedule").execute({
      date: "2025-09-01",
      dataDir: dir,
    }) as { classes: Array<{ name: string }> };
    assert.equal(JSON.stringify(result).includes("stored-secret"), false);
    assert.equal(JSON.stringify(result).includes("should-not-leak"), false);
    assert.equal(result.classes[0]?.name, "编译原理");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xdyou plugin reports a missing cache without reading preferences", async () => {
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "shared_preferences.json"), JSON.stringify({ flutteridsPassword: "secret" }));
    const result = await xdyouTool("schedule").execute({ dataDir: dir }) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /ClassTable.json/);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xdyou plugin exposes every cache-backed capability and reads aircon", async () => {
  const names = createPluginTools(xdyouPlugin).map((tool) => tool.descriptor.name).sort();
  assert.deepEqual(names, [
    "xdyou_aircon",
    "xdyou_airconlive",
    "xdyou_attendance",
    "xdyou_card",
    "xdyou_classrooms",
    "xdyou_electricity",
    "xdyou_exams",
    "xdyou_experiments",
    "xdyou_forum",
    "xdyou_library",
    "xdyou_loans",
    "xdyou_login",
    "xdyou_meters",
    "xdyou_network",
    "xdyou_schedule",
    "xdyou_schoolnet",
    "xdyou_scores",
    "xdyou_sport",
    "xdyou_sportclass",
    "xdyou_status",
    "xdyou_water",
  ]);
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "AirconEnergyCache.json"), JSON.stringify({
      imei: "device-1",
      fetchTime: "2026-11-11T02:00:00.000Z",
      stateTime: "2026-11-11T01:00:00.000Z",
      electricAmount: 12.5,
    }));
    const result = await xdyouTool("aircon").execute({ dataDir: dir }) as { electricAmount: number; imei: string };
    assert.equal(result.electricAmount, 12.5);
    assert.equal(result.imei, "device-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

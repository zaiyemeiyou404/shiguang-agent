import { readFileSync } from "node:fs";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { campusCardFromOutput, renderCampusBoardHtml, renderCardText } from "./xdyou-board.js";
import { boardPath } from "./xdyou-board-server.js";
import { xdyouManifest } from "./xdyou-plugin.js";

test("campus board renders a week timetable and escapes course names", () => {
  const card = campusCardFromOutput("id", "schedule", {
    ok: true,
    date: "2026-11-11",
    weekday: "周三",
    week: 9,
    classes: [{ name: "班级指导<script>", classroom: "B-506", startClock: "14:00", endClock: "15:35" }],
  });
  const html = renderCampusBoardHtml(card);
  assert.match(html, /第 10 周/);
  assert.match(html, /班级指导&lt;script&gt;/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.doesNotMatch(html, /班级指导<script>/);
  assert.equal(card.days.find((day) => day.today)?.classes[0]?.period, 5);
  assert.match(renderCardText(card), /周三（今天）/);
  assert.match(renderCardText(card), /班级指导/);
});

test("attendance card draws a rate bar and marks the warning", () => {
  const card = campusCardFromOutput("id", "attendance", {
    ok: true,
    semester: "20261",
    count: 2,
    warningCount: 1,
    courses: [
      { course: "品鉴养识：收藏里的艺术", rate: "0.0 %", absence: "1", warning: true },
      { course: "马克思主义基本原理", rate: "94.44 %", absence: "1", warning: false },
    ],
  });
  const html = renderCampusBoardHtml(card);
  assert.equal(card.items[0]?.meter, 0);
  assert.equal(card.items[1]?.meter, 94.44);
  assert.match(html, /class="bar"/);
  assert.match(html, /width:8%/);
  assert.match(html, /width:94.44%/);
});

test("scores card keeps the summary and only unfinished courses", () => {
  const card = campusCardFromOutput("id", "scores", {
    ok: true,
    summary: { passedCredits: 55.1, numericWeightedAverage: 85.1, pending: 1 },
    courses: [
      { name: "线性代数B", score: 90, credit: 3, semesterCode: "2025-2026-1", passed: true },
      { name: "大学物理K（Ⅱ）", score: null, credit: 4, semesterCode: "2026-2027-1", passed: null },
    ],
  });
  assert.deepEqual(card.items.map((item) => item.title), ["大学物理K（Ⅱ）"]);
  assert.equal(card.items[0]?.aside, "未出");
  assert.match(renderCampusBoardHtml(card), /55\.1/);
});

test("empty classroom cards list rooms and free periods", () => {
  const card = campusCardFromOutput("id", "classrooms", {
    ok: true,
    date: "2026-11-12",
    building: "B楼",
    count: 1,
    rooms: [{ name: "B-101", building: "B楼", free: [{ period: 1, start: "08:30", end: "09:15" }, { period: 2, start: "09:20", end: "10:05" }] }],
  });
  assert.deepEqual(card.items.map((item) => item.title), ["B-101"]);
  assert.equal(card.items[0]?.aside, "08:30–10:05");
  assert.equal(card.items.some((item) => item.title.includes("教学楼")), false);
});

test("card text carries the shared card link and every tool has a DSH frame", () => {
  const card = campusCardFromOutput("id", "exams", { ok: true, date: "2026-11-11", upcoming: [], earlierCount: 2 });
  const url = "http://127.0.0.1:47321/c/abc123abc123";
  assert.match(renderCardText(card, url), new RegExp(`卡片 ${url}`));
  assert.equal(renderCardText(card).includes("卡片"), false);
  assert.deepEqual(boardPath("/c/abc123abc123"), { ok: true, id: "abc123abc123" });
  assert.deepEqual(boardPath("/"), { ok: true, id: null });
  assert.equal(boardPath("/c/../board.html").ok, false);
  const client = readFileSync(new URL("../../dsh/xdyou-dsh-card/client.js", import.meta.url), "utf8");
  assert.match(client, /mcp__xdyou__/);
  for (const capability of xdyouManifest.capabilities) assert.match(client, new RegExp(`"${capability.id}"`));
});

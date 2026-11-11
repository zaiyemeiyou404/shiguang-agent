import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryXdyou } from "./xdyou-cache.js";
import { syncEhall, type EhallClient } from "./xdyou-sync.js";

test("ehall login sync writes schedule, scores, and exams without the student id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdyou-sync-"));
  const opened: string[] = [];
  const client: EhallClient = {
    async open(url) {
      opened.push(url);
    },
    async post(url) {
      if (url.includes("dqxnxq")) return { datas: { dqxnxq: { rows: [{ DM: "2025-2026-1" }] } } };
      if (url.includes("cxjcs")) return { datas: { cxjcs: { rows: [{ XQKSRQ: "2025-09-01 00:00:00" }] } } };
      if (url.includes("xskcb.do")) {
        return { datas: { xskcb: { extParams: { code: 1 }, rows: [{
          KCM: "操作系统", KCH: "CS101", KXH: "01", KSJC: "1", JSJC: "2", SKXQ: "1",
          SKZC: "1", SKJS: "张三", JASMC: "A-101",
        }] } } };
      }
      if (url.includes("cxxsllsywpk")) return { datas: { cxxsllsywpk: { rows: [] } } };
      if (url.includes("xsdkkc")) return { datas: { xsdkkc: { extParams: { code: 1 }, rows: [] } } };
      if (url.includes("xscjcx")) {
        return { datas: { xscjcx: { extParams: { code: 1 }, rows: [{
          XSKCM: "操作系统", ZCJ: 90, XNXQDM: "2025-2026-1", XF: 4,
          KCXZDM_DISPLAY: "必修", KCLBDM_DISPLAY: "专业", CXCKDM_DISPLAY: "",
          DJCJLXDM: "0", DJCJMC: "", SFJG: "1", JXBID: "1",
        }] } } };
      }
      if (url.includes("wdksap.do")) {
        return { code: "0", datas: { wdksap: { rows: [{
          KCM: "操作系统", KSMC: "期末考试", KSSJMS: "2026-01-10 08:00-10:00", JASMC: "B-1", ZWH: "12",
        }] } } };
      }
      if (url.includes("cxyxkwapkwdkc")) return { datas: { cxyxkwapkwdkc: { rows: [] } } };
      throw new Error(`unexpected ${url}`);
    },
  };

  try {
    const report = await syncEhall(client, "2300001234", dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.synced, ["schedule", "scores", "exams"]);
    assert.equal(report.accountSuffix, "1234");
    assert.equal(JSON.stringify(report).includes("2300001234"), false);
    assert.equal(opened.length, 2);

    const schedule = await queryXdyou({ dataset: "schedule", date: "2025-09-01", dataDir: dir }) as {
      classes?: Array<{ name?: string; classroom?: string; startClock?: string }>;
    };
    assert.equal(schedule.classes?.[0]?.name, "操作系统");
    assert.equal(schedule.classes?.[0]?.classroom, "A-101");
    assert.equal(schedule.classes?.[0]?.startClock, "08:30");

    const scores = await queryXdyou({ dataset: "scores", dataDir: dir }) as {
      summary?: { numericWeightedAverage?: number };
    };
    assert.equal(scores.summary?.numericWeightedAverage, 90);

    const exams = await queryXdyou({ dataset: "exams", date: "2025-09-01", dataDir: dir }) as {
      upcoming?: Array<{ subject?: string; seat?: string }>;
    };
    assert.equal(exams.upcoming?.[0]?.subject, "操作系统");
    assert.equal(exams.upcoming?.[0]?.seat, "12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

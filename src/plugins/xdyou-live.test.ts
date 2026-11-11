import { test } from "node:test";
import * as assert from "node:assert/strict";
import { queryCampusNetwork, searchLibrary } from "./xdyou-live.js";

test("library search projects catalog rows and rejects an empty query", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: {
      searchResult: [{
        title: "操作系统",
        author: "张三",
        publisher: "高等教育出版社",
        publishYear: "2020",
        isbn: "9780000000000",
        callNo: ["TP316"],
        onShelfCountI: 2,
        groupPhysicalCount: 5,
        recordId: 42,
        password: "do-not-keep",
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const missing = await searchLibrary("  ", 5);
    assert.equal(missing.ok, false);
    const result = await searchLibrary("操作系统", 5) as { books: Array<{ title: string; available: number }> };
    assert.equal(result.books[0]?.title, "操作系统");
    assert.equal(result.books[0]?.available, 2);
    assert.equal(JSON.stringify(result).includes("do-not-keep"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("campus network query keeps usage fields and drops identity fields", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`jsonp(${JSON.stringify({
    products_name: "学生套餐",
    remain_bytes: 1024,
    sum_bytes: 2048,
    online_device_total: "1",
    real_name: "不应返回",
    user_name: "不应返回",
    user_mac: "aa:bb",
  })});`, { status: 200 })) as typeof fetch;
  try {
    const result = await queryCampusNetwork();
    assert.equal(result.productsName, "学生套餐");
    assert.equal(result.remainBytes, 1024);
    assert.equal(JSON.stringify(result).includes("不应返回"), false);
    assert.equal(JSON.stringify(result).includes("aa:bb"), false);
  } finally {
    globalThis.fetch = original;
  }
});

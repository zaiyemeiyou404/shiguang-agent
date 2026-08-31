import { test } from "node:test";
import * as assert from "node:assert/strict";

type WebFetchTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type WebFetchModule = {
  createWebFetchTool(): WebFetchTool;
};

type WebFetchOutput = {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
  htmlPreview?: string;
  htmlPreviewTruncated?: boolean;
};

async function loadModule(): Promise<WebFetchModule> {
  return import("./web-fetch.js") as Promise<WebFetchModule>;
}

function assertOutput(value: unknown): asserts value is WebFetchOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<WebFetchOutput>;
  assert.equal(typeof output.url, "string");
  assert.equal(typeof output.status, "number");
  assert.equal(typeof output.contentType, "string");
  assert.equal(typeof output.text, "string");
  assert.equal(typeof output.truncated, "boolean");
}

test("web_fetch returns readable text, title, and an HTML preview for HTML pages", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<!doctype html><html><head><title>测试文章</title><style>.x{}</style></head><body><h1>标题</h1><p>正文内容</p><script>bad()</script></body></html>",
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    assert.equal(tool.descriptor.name, "web_fetch");
    assert.equal(tool.descriptor.risk, "read");
    assert.equal(tool.descriptor.requiresApproval, false);
    assert.equal(tool.descriptor.capability, "web.read");

    const result = await tool.execute({ url: "https://example.test/article.html" });

    assertOutput(result);
    assert.equal(result.url, "https://example.test/article.html");
    assert.equal(result.status, 200);
    assert.equal(result.title, "测试文章");
    assert.match(result.text, /标题/);
    assert.match(result.text, /正文内容/);
    assert.doesNotMatch(result.text, /bad\(\)/);
    assert.match(result.htmlPreview ?? "", /<!doctype html>/i);
    assert.equal(result.htmlPreviewTruncated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


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
  articleCandidates?: Array<{ source: string; score: number; text: string; truncated: boolean }>;
  extraction?: { strategy: string; candidateCount: number; needsModelReview: boolean; hint: string };
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

test("web_fetch prefers news article body over navigation chrome", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<!doctype html>
    <html>
      <head><title>红色文化研究：进程、成就与展望川观新闻</title></head>
      <body>
        <div class="site-nav">
          APP
          下载川观新闻客户端
          微信
          关注四川日报公众号
          举报
        </div>
        <main class="news-detail article-content">
          <h1>红色文化研究：进程、成就与展望</h1>
          <p>光明日报</p>
          <p>2024-12-18 10:29</p>
          <p>“红色文化”是中国共产党领导中国人民在实现中华民族复兴伟业的进程中铸就的文化。</p>
          <p>它体现着中国共产党的思想理念、价值追求和精神品格。</p>
          <p>未经授权，严禁转载！联系电话：0000</p>
        </main>
      </body>
    </html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.test/news.html" });

    assertOutput(result);
    assert.match(result.text, /红色文化研究：进程、成就与展望/);
    assert.match(result.text, /中华民族复兴伟业/);
    assert.doesNotMatch(result.text, /下载川观新闻客户端/);
    assert.doesNotMatch(result.text, /联系电话/);
    assert.ok(result.articleCandidates);
    assert.ok(result.articleCandidates.length >= 1);
    assert.match(result.articleCandidates[0]?.text ?? "", /中华民族复兴伟业/);
    assert.equal(result.extraction?.strategy, "article_candidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

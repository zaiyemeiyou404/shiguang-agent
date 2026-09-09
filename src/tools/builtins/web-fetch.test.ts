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

type Readability = {
  status: "strong" | "weak" | "failed";
  score: number;
  textChars: number;
  paragraphCount: number;
  boilerplateHits: number;
  reasons: string[];
};

type WebFetchOutput = {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
  articleCandidates?: Array<{ source: string; score: number; text: string; truncated: boolean; textChars: number; paragraphCount: number }>;
  extraction?: {
    strategy: string;
    candidateCount: number;
    needsModelReview: boolean;
    selectedSource?: string;
    quality?: Readability;
    qualitySummary?: string;
    nextAction?: "answer_from_body" | "extract_links" | "search_alternate";
    hint: string;
  };
  readability?: Readability;
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
    assert.equal(typeof result.articleCandidates[0]?.textChars, "number");
    assert.equal(result.extraction?.strategy, "article_candidate");
    assert.equal(result.extraction?.quality?.status, "strong");
    assert.equal(result.extraction?.nextAction, "answer_from_body");
    assert.equal(result.readability?.status, "strong");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch marks shell pages as weak or failed body evidence", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<!doctype html>
    <html>
      <head><title>下载客户端</title></head>
      <body>
        <nav>APP 下载客户端 微信 关注公众号 评论 分享 举报</nav>
        <a href="/real-article.html">阅读全文</a>
        <footer>版权所有 ICP备案</footer>
      </body>
    </html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.test/shell.html" });

    assertOutput(result);
    assert.notEqual(result.extraction?.quality?.status, "strong");
    assert.equal(result.extraction?.needsModelReview, true);
    assert.match(result.extraction?.hint ?? "", /web_extract_links/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch extracts articleBody from JSON-LD when available", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<!doctype html>
    <html>
      <head>
        <title>Red Culture Report</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "NewsArticle",
            "headline": "Red Culture Report",
            "articleBody": "This is the real article body. It explains the research progress, current results, and future outlook in complete paragraphs."
          }
        </script>
      </head>
      <body>
        <nav>Download the app. Follow us. Comment here.</nav>
        <div>Navigation and sharing buttons only.</div>
      </body>
    </html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.test/jsonld.html" });

    assertOutput(result);
    assert.match(result.text, /real article body/);
    assert.doesNotMatch(result.text, /Navigation and sharing buttons/);
    assert.equal(result.articleCandidates?.[0]?.source, "json-ld:articleBody");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch can infer an article from dense paragraph clusters", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<!doctype html>
    <html>
      <head><title>Simple News Page</title></head>
      <body>
        <header>Home Search Download Client</header>
        <div class="layout">
          <aside>Recommended links and comments</aside>
          <section>
            <p>Source: Example Daily</p>
            <p>The article begins with a substantial opening paragraph about the topic and why it matters to readers.</p>
            <p>The second paragraph adds evidence, background, and details that belong to the real story rather than navigation.</p>
            <p>The third paragraph closes the report with a useful summary and a clear takeaway for the audience.</p>
          </section>
        </div>
        <footer>Copyright ICP comments download client</footer>
      </body>
    </html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.test/paragraphs.html" });

    assertOutput(result);
    assert.match(result.text, /substantial opening paragraph/);
    assert.match(result.text, /clear takeaway/);
    assert.doesNotMatch(result.text, /Recommended links/);
    assert.ok(result.articleCandidates?.some((candidate) => candidate.source.startsWith("paragraph_cluster")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch can extract article text hidden in page scripts", async () => {
  const { createWebFetchTool } = await loadModule();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    `<!doctype html>
    <html>
      <head><title>Script Article</title></head>
      <body>
        <nav>Download App Login Register</nav>
        <script>
          window.__ARTICLE__ = {
            "articleBody": "The first article paragraph explains the concept of web search. Search engines crawl and index pages, then return relevant ranked results. The second paragraph explains that users type keywords and the system retrieves, ranks, and summarizes candidate pages. The third paragraph emphasizes that search snippets are only candidates, so an agent should open the selected page and verify the body before giving a final answer."
          };
          window.__DATA__ = {
            "content": "第一段正文介绍网络搜索的概念，它通过搜索引擎索引网页并返回相关结果。第二段正文说明用户输入关键词后，系统会进行召回、排序和摘要展示。第三段正文强调搜索结果还需要进一步打开网页核验，不能只依赖搜索片段。"
          };
        </script>
      </body>
    </html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  try {
    const tool = createWebFetchTool();
    const result = await tool.execute({ url: "https://example.test/script.html" });

    assertOutput(result);
    assert.match(result.text, /Search engines crawl and index pages/);
    assert.equal(result.articleCandidates?.[0]?.source, "embedded:script-text");
    assert.equal(result.extraction?.selectedSource, "embedded:script-text");
    assert.match(result.extraction?.qualitySummary ?? "", /status=strong/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

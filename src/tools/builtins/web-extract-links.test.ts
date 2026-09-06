import { test } from "node:test";
import * as assert from "node:assert/strict";

type WebExtractLinksTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type WebExtractLinksModule = {
  createWebExtractLinksTool(): WebExtractLinksTool;
};

type WebExtractLinksOutput = {
  links: Array<{ url: string; text: string; score: number; sameHost: boolean }>;
  totalLinks: number;
};

async function loadModule(): Promise<WebExtractLinksModule> {
  return import("./web-extract-links.js") as Promise<WebExtractLinksModule>;
}

function assertOutput(value: unknown): asserts value is WebExtractLinksOutput {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const output = value as Partial<WebExtractLinksOutput>;
  assert.equal(Array.isArray(output.links), true);
  assert.equal(typeof output.totalLinks, "number");
}

test("web_extract_links ranks article links from raw HTML", async () => {
  const { createWebExtractLinksTool } = await loadModule();
  const tool = createWebExtractLinksTool();

  assert.equal(tool.descriptor.name, "web_extract_links");
  assert.equal(tool.descriptor.risk, "read");
  assert.equal(tool.descriptor.requiresApproval, false);
  assert.equal(tool.descriptor.capability, "web.extract_links");

  const result = await tool.execute({
    baseUrl: "https://example.test/news/index.html",
    html: `
      <a href="/download/app">下载客户端</a>
      <a href="/2026/09/06/red-culture.html">阅读全文：红色文化研究</a>
      <a href="https://external.test/article.html">外部文章</a>
    `,
  });

  assertOutput(result);
  assert.equal(result.totalLinks, 2);
  assert.equal(result.links[0]?.url, "https://example.test/2026/09/06/red-culture.html");
  assert.match(result.links[0]?.text ?? "", /阅读全文/);
});

test("web_extract_links can include external links when requested", async () => {
  const { createWebExtractLinksTool } = await loadModule();
  const tool = createWebExtractLinksTool();

  const result = await tool.execute({
    baseUrl: "https://example.test/",
    html: `<a href="https://external.test/news.html">外部新闻正文</a>`,
    includeExternal: true,
  });

  assertOutput(result);
  assert.equal(result.links[0]?.url, "https://external.test/news.html");
  assert.equal(result.links[0]?.sameHost, false);
});

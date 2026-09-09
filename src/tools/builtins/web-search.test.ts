import { test } from "node:test";
import * as assert from "node:assert/strict";

type WebSearchTool = {
  descriptor: {
    name: string;
    risk?: string;
    requiresApproval?: boolean;
    capability?: string;
  };
  execute(input: unknown): Promise<unknown>;
};

type WebSearchModule = {
  createWebSearchTool(): WebSearchTool;
};

async function loadModule(): Promise<WebSearchModule> {
  return import("./web-search.js") as Promise<WebSearchModule>;
}

function withMockedSearchEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    originalEnv[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("web_search uses Tavily when configured", async () => {
  await withMockedSearchEnv({
    TAVILY_API_KEY: "tavily-key",
    BRAVE_SEARCH_API_KEY: undefined,
    SHIGUANG_WEB_SEARCH_PROVIDER: undefined,
  }, async () => {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.tavily.com/search");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tavily-key");
      assert.match(String(init?.body), /"query":"agent runtime"/);
      return new Response(JSON.stringify({
        results: [
          { title: "Agent Runtime", url: "https://example.test/agent", content: "Runtime overview", score: 0.9 },
        ],
        usage: { search_depth: "basic" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { createWebSearchTool } = await loadModule();
    const result = await createWebSearchTool().execute({ query: "agent runtime", limit: 3 });

    assert.deepEqual(result, {
      query: "agent runtime",
      provider: "tavily",
      results: [
        { title: "Agent Runtime", url: "https://example.test/agent", snippet: "Runtime overview", score: 0.9 },
      ],
      usage: { search_depth: "basic" },
    });
  });
});

test("web_search falls back to Brave when Tavily is not configured", async () => {
  await withMockedSearchEnv({
    TAVILY_API_KEY: undefined,
    BRAVE_SEARCH_API_KEY: "brave-key",
    SHIGUANG_WEB_SEARCH_PROVIDER: undefined,
  }, async () => {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
      assert.equal(url.searchParams.get("q"), "agent runtime");
      assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "brave-key");
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: "<b>Agent</b> Runtime", url: "https://brave.test/agent", description: "Search result" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { createWebSearchTool } = await loadModule();
    const result = await createWebSearchTool().execute({ query: "agent runtime", limit: 3 });

    assert.deepEqual(result, {
      query: "agent runtime",
      provider: "brave",
      results: [
        { title: "Agent Runtime", url: "https://brave.test/agent", snippet: "Search result" },
      ],
    });
  });
});

test("web_search explicit provider fails fast when its key is missing", async () => {
  await withMockedSearchEnv({
    TAVILY_API_KEY: undefined,
    BRAVE_SEARCH_API_KEY: undefined,
    SHIGUANG_WEB_SEARCH_PROVIDER: undefined,
  }, async () => {
    const { createWebSearchTool } = await loadModule();

    await assert.rejects(
      () => createWebSearchTool().execute({ query: "agent runtime", provider: "tavily" }),
      /missing TAVILY_API_KEY/,
    );
  });
});

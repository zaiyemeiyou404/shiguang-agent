import type { Tool, ToolExecutionContext } from "../types.js";

interface WebSearchInput {
  query: string;
  limit?: number;
}

function parseInput(input: unknown): WebSearchInput {
  if (typeof input === "string") return { query: input };
  if (!input || typeof input !== "object") {
    throw new Error("web_search: input must be a query string or { query, limit? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.query !== "string" || !obj.query.trim()) {
    throw new Error("web_search: query must be a non-empty string");
  }
  return {
    query: obj.query,
    ...(typeof obj.limit === "number" ? { limit: obj.limit } : {}),
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDuckDuckGoResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>|<div[^>]+class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  for (const match of html.matchAll(blockPattern)) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const url = rawUrl.includes("uddg=")
      ? decodeURIComponent(new URL(rawUrl, "https://duckduckgo.com").searchParams.get("uddg") ?? rawUrl)
      : rawUrl;
    const title = decodeHtml((match[2] ?? "").replace(/<[^>]+>/g, " "));
    const snippet = decodeHtml((match[3] ?? "").replace(/<[^>]+>/g, " "));
    if (!title || !url) continue;
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

function extractBingResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockPattern = /<li[^>]+class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  for (const match of html.matchAll(blockPattern)) {
    const url = decodeHtml(match[1] ?? "");
    const title = decodeHtml((match[2] ?? "").replace(/<[^>]+>/g, " "));
    const snippet = decodeHtml((match[3] ?? "").replace(/<[^>]+>/g, " "));
    if (!title || !url) continue;
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

async function fetchSearchHtml(url: URL, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 ShiguangAgent/1.0",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return html;
}

export function createWebSearchTool(): Tool {
  return {
    descriptor: {
      name: "web_search",
      description: "Search the public web and return compact result titles, URLs, and snippets. Accepts { query, limit? }.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "web.search",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const parsed = parseInput(input);
      const limit = Math.max(1, Math.min(10, Math.trunc(parsed.limit ?? 5)));
      const errors: string[] = [];

      const duckDuckGoUrl = new URL("https://duckduckgo.com/html/");
      duckDuckGoUrl.searchParams.set("q", parsed.query);
      try {
        const html = await fetchSearchHtml(duckDuckGoUrl, context?.signal);
        const results = extractDuckDuckGoResults(html, limit);
        if (results.length > 0) {
          return { query: parsed.query, provider: "duckduckgo", results };
        }
        errors.push("duckduckgo returned no parseable results");
      } catch (error) {
        errors.push(`duckduckgo: ${error instanceof Error ? error.message : String(error)}`);
      }

      const bingUrl = new URL("https://www.bing.com/search");
      bingUrl.searchParams.set("q", parsed.query);
      try {
        const html = await fetchSearchHtml(bingUrl, context?.signal);
        const results = extractBingResults(html, limit);
        if (results.length > 0) {
          return { query: parsed.query, provider: "bing", results };
        }
        errors.push("bing returned no parseable results");
      } catch (error) {
        errors.push(`bing: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new Error(`web_search failed: ${errors.join("; ")}. 请检查网络、代理/TUN、DNS 或防火墙设置。`);
    },
  };
}

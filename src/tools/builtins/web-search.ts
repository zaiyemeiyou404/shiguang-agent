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
      const url = new URL("https://duckduckgo.com/html/");
      url.searchParams.set("q", parsed.query);
      const response = await fetch(url, {
        signal: context?.signal,
        headers: {
          "User-Agent": "shiguang-agent",
          Accept: "text/html",
        },
      });
      const html = await response.text();
      if (!response.ok) {
        throw new Error(`web_search failed: ${response.status} ${response.statusText}`);
      }
      return {
        query: parsed.query,
        results: extractDuckDuckGoResults(html, limit),
      };
    },
  };
}

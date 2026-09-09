import type { Tool, ToolExecutionContext } from "../types.js";

interface WebSearchInput {
  query: string;
  limit?: number;
  provider?: "auto" | "tavily" | "brave" | "duckduckgo" | "bing";
}

interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
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
    ...(typeof obj.provider === "string" ? { provider: normalizeProvider(obj.provider) } : {}),
  };
}

function normalizeProvider(value: string): WebSearchInput["provider"] {
  const provider = value.trim().toLowerCase();
  if (provider === "tavily" || provider === "brave" || provider === "duckduckgo" || provider === "bing" || provider === "auto") {
    return provider;
  }
  throw new Error("web_search: provider must be one of auto, tavily, brave, duckduckgo, or bing");
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

async function postJson(url: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 ShiguangAgent/1.0",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function fetchJson(url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 ShiguangAgent/1.0",
      ...headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function normalizeTavilyResults(payload: unknown, limit: number): { answer?: string; results: NormalizedSearchResult[]; usage?: unknown } {
  const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rawResults = Array.isArray(obj.results) ? obj.results : [];
  const results = rawResults
    .map((item): NormalizedSearchResult | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const snippet = typeof record.content === "string"
        ? record.content.trim()
        : typeof record.snippet === "string"
          ? record.snippet.trim()
          : "";
      const score = typeof record.score === "number" ? record.score : undefined;
      return title && url ? { title, url, snippet, ...(score !== undefined ? { score } : {}) } : null;
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, limit);
  return {
    ...(typeof obj.answer === "string" && obj.answer.trim() ? { answer: obj.answer.trim() } : {}),
    results,
    ...(obj.usage !== undefined ? { usage: obj.usage } : {}),
  };
}

function normalizeBraveResults(payload: unknown, limit: number): NormalizedSearchResult[] {
  const obj = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const web = obj.web && typeof obj.web === "object" ? obj.web as Record<string, unknown> : {};
  const rawResults = Array.isArray(web.results) ? web.results : [];
  return rawResults
    .map((item): NormalizedSearchResult | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? decodeHtml(record.title.replace(/<[^>]+>/g, " ")).trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const description = typeof record.description === "string" ? record.description : "";
      const extraSnippets = Array.isArray(record.extra_snippets) ? record.extra_snippets.filter((part): part is string => typeof part === "string") : [];
      const snippet = decodeHtml([description, ...extraSnippets].join(" ").replace(/<[^>]+>/g, " ")).trim();
      return title && url ? { title, url, snippet } : null;
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, limit);
}

async function searchTavily(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const apiKey = readEnv("TAVILY_API_KEY");
  if (!apiKey) throw new Error("missing TAVILY_API_KEY");
  const payload = await postJson("https://api.tavily.com/search", apiKey, {
    query,
    search_depth: "basic",
    max_results: limit,
    topic: "general",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_usage: true,
  }, signal);
  const normalized = normalizeTavilyResults(payload, limit);
  if (normalized.results.length === 0) throw new Error("tavily returned no results");
  return { query, provider: "tavily", ...normalized };
}

async function searchBrave(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const apiKey = readEnv("BRAVE_SEARCH_API_KEY");
  if (!apiKey) throw new Error("missing BRAVE_SEARCH_API_KEY");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, limit)));
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("extra_snippets", "true");
  const payload = await fetchJson(url, { "X-Subscription-Token": apiKey }, signal);
  const results = normalizeBraveResults(payload, limit);
  if (results.length === 0) throw new Error("brave returned no results");
  return { query, provider: "brave", results };
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const duckDuckGoUrl = new URL("https://duckduckgo.com/html/");
  duckDuckGoUrl.searchParams.set("q", query);
  const html = await fetchSearchHtml(duckDuckGoUrl, signal);
  const results = extractDuckDuckGoResults(html, limit);
  if (results.length === 0) throw new Error("duckduckgo returned no parseable results");
  return { query, provider: "duckduckgo", results };
}

async function searchBing(query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const bingUrl = new URL("https://www.bing.com/search");
  bingUrl.searchParams.set("q", query);
  const html = await fetchSearchHtml(bingUrl, signal);
  const results = extractBingResults(html, limit);
  if (results.length === 0) throw new Error("bing returned no parseable results");
  return { query, provider: "bing", results };
}

function preferredSearchProviders(requested: WebSearchInput["provider"]): Array<NonNullable<WebSearchInput["provider"]>> {
  if (requested && requested !== "auto") return [requested];
  const envProvider = normalizeOptionalProvider(process.env.SHIGUANG_WEB_SEARCH_PROVIDER);
  if (envProvider && envProvider !== "auto") {
    const providers: Array<NonNullable<WebSearchInput["provider"]>> = [envProvider, "tavily", "brave", "duckduckgo", "bing"];
    return providers.filter(uniqueProvider);
  }
  return ["tavily", "brave", "duckduckgo", "bing"];
}

function normalizeOptionalProvider(value: string | undefined): WebSearchInput["provider"] | null {
  if (!value?.trim()) return null;
  return normalizeProvider(value);
}

function uniqueProvider(value: NonNullable<WebSearchInput["provider"]>, index: number, array: Array<NonNullable<WebSearchInput["provider"]>>): boolean {
  return array.indexOf(value) === index;
}

async function runSearchProvider(provider: NonNullable<WebSearchInput["provider"]>, query: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  switch (provider) {
    case "tavily":
      return searchTavily(query, limit, signal);
    case "brave":
      return searchBrave(query, limit, signal);
    case "duckduckgo":
      return searchDuckDuckGo(query, limit, signal);
    case "bing":
      return searchBing(query, limit, signal);
    case "auto":
      throw new Error("auto is not an executable search provider");
  }
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
          provider: { type: "string", description: "Optional: auto, tavily, brave, duckduckgo, or bing." },
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
      for (const provider of preferredSearchProviders(parsed.provider)) {
        try {
          return await runSearchProvider(provider, parsed.query, limit, context?.signal);
        } catch (error) {
          errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
          if (parsed.provider && parsed.provider !== "auto") break;
        }
      }

      throw new Error(`web_search failed: ${errors.join("; ")}. 请检查网络、代理/TUN、DNS 或防火墙设置。`);
    },
  };
}

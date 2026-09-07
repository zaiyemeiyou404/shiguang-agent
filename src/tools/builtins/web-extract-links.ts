import type { Tool, ToolExecutionContext } from "../types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_HTML_CHARS = 500_000;
const MAX_LINKS = 80;

interface WebExtractLinksInput {
  url?: string;
  html?: string;
  baseUrl?: string;
  includeExternal?: boolean;
  limit?: number;
}

interface ExtractedLink {
  url: string;
  text: string;
  score: number;
  sameHost: boolean;
}

interface WebExtractLinksOutput {
  sourceUrl?: string;
  links: ExtractedLink[];
  totalLinks: number;
  hint: string;
}

function parseInput(input: unknown): WebExtractLinksInput {
  if (typeof input === "string") {
    if (/^https?:\/\//i.test(input)) return { url: input };
    return { html: input };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("web_extract_links: input must be a URL string, HTML string, or { url?, html?, baseUrl? }");
  }
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.html === "string" ? { html: record.html } : {}),
    ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.includeExternal === "boolean" ? { includeExternal: record.includeExternal } : {}),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
  };
}

function assertHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_extract_links: only http and https URLs are supported");
  }
  return url;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

async function fetchHtml(url: URL, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 ShiguangAgent/1.0",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`web_extract_links failed: ${response.status} ${response.statusText}`);
    }
    return (await response.text()).slice(0, MAX_HTML_CHARS);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textFromHtml(fragment: string): string {
  return decodeHtml(fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function getAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))
    ?? tag.match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, "i"));
  return decodeHtml((match?.[2] ?? match?.[1] ?? "").trim()) || null;
}

function getHref(tag: string): string | null {
  return getAttribute(tag, "href");
}

function normalizeCandidateUrl(href: string, baseUrl: URL | null): string | null {
  if (!href || href.startsWith("#") || /^javascript:|^mailto:|^tel:/i.test(href)) return null;
  try {
    const url = baseUrl ? new URL(href, baseUrl) : new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function scoreLink(url: string, text: string): number {
  const haystack = `${url} ${text}`.toLowerCase();
  let score = 0;
  if (/正文|全文|阅读全文|详情|新闻|文章|报道|内容|专题|article|news|detail|story|read/.test(haystack)) score += 30;
  if (/\d{4}[/-]?\d{0,2}[/-]?\d{0,2}|\/20\d{2}\//.test(haystack)) score += 12;
  if (/\.(html?|shtml)(?:$|\?)/i.test(url)) score += 10;
  if (/login|signin|register|comment|share|download|app|javascript|广告|评论|下载|客户端/.test(haystack)) score -= 24;
  if (text.length >= 8 && text.length <= 80) score += 8;
  return score;
}

function addCandidateLink(
  byUrl: Map<string, ExtractedLink>,
  href: string | null,
  text: string,
  baseUrl: URL | null,
  includeExternal: boolean,
): void {
  if (!href) return;
  const normalized = normalizeCandidateUrl(href, baseUrl);
  if (!normalized) return;
  const linkUrl = new URL(normalized);
  const sameHost = baseUrl ? linkUrl.hostname === baseUrl.hostname : true;
  if (!includeExternal && !sameHost) return;
  const label = text.trim() || normalized;
  const next = {
    url: normalized,
    text: label,
    sameHost,
    score: scoreLink(normalized, label),
  };
  const existing = byUrl.get(normalized);
  if (!existing || next.score > existing.score) byUrl.set(normalized, next);
}

function extractJsonLdUrls(html: string): Array<{ url: string; text: string }> {
  const candidates: Array<{ url: string; text: string }> = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = decodeHtml(match[2] ?? "").trim();
    if (!raw) continue;
    const title = raw.match(/"headline"\s*:\s*"([\s\S]*?)"/i)?.[1]
      ?? raw.match(/"name"\s*:\s*"([\s\S]*?)"/i)?.[1]
      ?? "structured article link";
    for (const urlMatch of raw.matchAll(/"(?:url|@id)"\s*:\s*"([^"]+https?:\/\/[^"]+|https?:\/\/[^"]+)"/gi)) {
      candidates.push({ url: urlMatch[1] ?? "", text: decodeHtml(title) });
    }
    for (const pageMatch of raw.matchAll(/"mainEntityOfPage"\s*:\s*(?:"([^"]+)"|\{[\s\S]*?"@id"\s*:\s*"([^"]+)"[\s\S]*?\})/gi)) {
      candidates.push({ url: pageMatch[1] ?? pageMatch[2] ?? "", text: decodeHtml(title) });
    }
  }
  return candidates;
}

function extractMetadataLinks(html: string): Array<{ url: string; text: string }> {
  const candidates: Array<{ url: string; text: string }> = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0] ?? "";
    const rel = getAttribute(tag, "rel")?.toLowerCase() ?? "";
    if (!/(canonical|amphtml|alternate)/.test(rel)) continue;
    candidates.push({ url: getAttribute(tag, "href") ?? "", text: rel.includes("canonical") ? "canonical article URL" : "alternate article URL" });
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0] ?? "";
    const key = `${getAttribute(tag, "property") ?? ""} ${getAttribute(tag, "name") ?? ""}`.toLowerCase();
    if (!/(og:url|twitter:url|article|publishurl|shareurl|url)/.test(key)) continue;
    candidates.push({ url: getAttribute(tag, "content") ?? "", text: key.trim() || "metadata article URL" });
  }
  return candidates;
}

function extractInlineArticleUrls(html: string): Array<{ url: string; text: string }> {
  const candidates: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/g)) {
    const raw = (match[0] ?? "").replace(/\\\//g, "/").replace(/[)"'<>\\]+$/g, "");
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!/\.(?:html?|shtml)(?:$|[?#])|\/20\d{2}[/-]/i.test(raw)) continue;
    candidates.push({ url: raw, text: "inline article URL" });
  }
  return candidates;
}

function extractLinks(html: string, baseUrl: URL | null, includeExternal: boolean, limit: number): ExtractedLink[] {
  const byUrl = new Map<string, ExtractedLink>();
  for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = match[0] ?? "";
    addCandidateLink(byUrl, getHref(tag), textFromHtml(tag), baseUrl, includeExternal);
  }
  for (const candidate of [
    ...extractMetadataLinks(html),
    ...extractJsonLdUrls(html),
    ...extractInlineArticleUrls(html),
  ]) {
    addCandidateLink(byUrl, candidate.url, candidate.text, baseUrl, includeExternal);
  }
  return Array.from(byUrl.values())
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .slice(0, Math.max(1, Math.min(MAX_LINKS, Math.trunc(limit))));
}

export function createWebExtractLinksTool(): Tool {
  return {
    descriptor: {
      name: "web_extract_links",
      description: "Extract and rank useful links from a web page or HTML. Use when web_fetch text is incomplete and the article/full-text link may be hidden in page links.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Optional URL to fetch and extract links from." },
          html: { type: "string", description: "Optional raw HTML or htmlPreview from web_fetch." },
          baseUrl: { type: "string", description: "Base URL used to resolve relative links when html is provided." },
          includeExternal: { type: "boolean", description: "Whether to include links to other hosts. Default false." },
          limit: { type: "number", description: "Maximum returned links. Default 20, hard max 80." },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "web.extract_links",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<WebExtractLinksOutput> {
      throwIfAborted(context?.signal);
      const parsed = parseInput(input);
      if (!parsed.url && !parsed.html) {
        throw new Error("web_extract_links: provide url or html");
      }
      const base = parsed.baseUrl ?? parsed.url;
      const baseUrl = base ? assertHttpUrl(base) : null;
      const html = typeof parsed.html === "string"
        ? parsed.html.slice(0, MAX_HTML_CHARS)
        : await fetchHtml(assertHttpUrl(parsed.url ?? ""), context?.signal);
      throwIfAborted(context?.signal);
      const limit = parsed.limit ?? 20;
      const links = extractLinks(html, baseUrl, parsed.includeExternal === true, limit);
      return {
        ...(parsed.url ? { sourceUrl: parsed.url } : {}),
        links,
        totalLinks: links.length,
        hint: links.length > 0
          ? "Fetch the highest scoring relevant link before answering from page content."
          : "No usable links found; try web_search with the page title or provide another source.",
      };
    },
  };
}

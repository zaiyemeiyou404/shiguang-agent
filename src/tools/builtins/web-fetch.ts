import type { Tool, ToolExecutionContext } from "../types.js";

const MAX_TEXT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 20_000;

interface WebFetchInput {
  url: string;
  maxChars?: number;
}

function parseInput(input: unknown): WebFetchInput {
  if (typeof input === "string") return { url: input };
  if (!input || typeof input !== "object") {
    throw new Error("web_fetch: input must be a URL string or { url, maxChars? }");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.url !== "string" || !obj.url.trim()) {
    throw new Error("web_fetch: url must be a non-empty string");
  }
  return {
    url: obj.url,
    ...(typeof obj.maxChars === "number" ? { maxChars: obj.maxChars } : {}),
  };
}

function assertHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch: only http and https URLs are supported");
  }
  return url;
}

function trim(value: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1_000, Math.min(MAX_TEXT_CHARS, Math.trunc(maxChars)));
  return {
    text: value.slice(0, limit),
    truncated: value.length > limit,
  };
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\n\s+\n/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchWithTimeout(url: URL, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const abortHandler = () => controller.abort();
  signal?.addEventListener("abort", abortHandler, { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "shiguang-agent",
        Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortHandler);
  }
}

export function createWebFetchTool(): Tool {
  return {
    descriptor: {
      name: "web_fetch",
      description: "Fetch a web page or text URL and return readable text. Accepts { url, maxChars? }.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["url"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "web.read",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const parsed = parseInput(input);
      const url = assertHttpUrl(parsed.url);
      const response = await fetchWithTimeout(url, context?.signal);
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`web_fetch failed: ${response.status} ${response.statusText} - ${raw.slice(0, 300)}`);
      }
      const readable = /html/i.test(contentType) ? htmlToText(raw) : raw.trim();
      const limited = trim(readable, parsed.maxChars ?? MAX_TEXT_CHARS);
      return {
        url: url.toString(),
        status: response.status,
        contentType,
        text: limited.text,
        truncated: limited.truncated,
      };
    },
  };
}


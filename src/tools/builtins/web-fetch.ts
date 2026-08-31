import type { Tool, ToolExecutionContext } from "../types.js";

const MAX_TEXT_CHARS = 20_000;
const MAX_HTML_PREVIEW_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const HEAD_DECODE_BYTES = 16_384;

interface WebFetchInput {
  url: string;
  maxChars?: number;
}

interface ReadableCandidate {
  source: string;
  score: number;
  text: string;
  truncated: boolean;
}

interface ExtractedReadableHtml {
  text: string;
  articleCandidates: ReadableCandidate[];
  extraction: {
    strategy: "article_candidate" | "whole_body";
    candidateCount: number;
    needsModelReview: boolean;
    hint: string;
  };
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

function trimWithLimit(value: string, maxChars: number, hardLimit: number): { text: string; truncated: boolean } {
  const limit = Math.max(1_000, Math.min(hardLimit, Math.trunc(maxChars)));
  return {
    text: value.slice(0, limit),
    truncated: value.length > limit,
  };
}

function trimText(value: string, maxChars: number): { text: string; truncated: boolean } {
  return trimWithLimit(value, maxChars, MAX_TEXT_CHARS);
}

function trimHtmlPreview(value: string): { htmlPreview: string; htmlPreviewTruncated: boolean } {
  const limited = trimWithLimit(value, MAX_HTML_PREVIEW_CHARS, MAX_HTML_PREVIEW_CHARS);
  return {
    htmlPreview: limited.text,
    htmlPreviewTruncated: limited.truncated,
  };
}

function extractTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!title) return undefined;
  return htmlToText(title).replace(/\s+/g, " ").trim() || undefined;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToText(html: string): string {
  return normalizeText(html
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
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16))));
}

function normalizeCharset(value: string | undefined): string | null {
  const charset = value?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (!charset) return null;
  if (charset === "gb2312" || charset === "gbk" || charset === "gb18030") return "gb18030";
  if (charset === "utf8") return "utf-8";
  return charset;
}

function inferCharsetFromHtmlPreview(preview: string): string | null {
  const direct = preview.match(/<meta\b[^>]*charset\s*=\s*["']?\s*([^"'>\s;]+)/i)?.[1];
  if (direct) return normalizeCharset(direct);
  const contentTypeMeta = preview.match(/<meta\b[^>]*http-equiv\s*=\s*["']content-type["'][^>]*content\s*=\s*["'][^"']*charset=([^"'\s;]+)/i)?.[1]
    ?? preview.match(/<meta\b[^>]*content\s*=\s*["'][^"']*charset=([^"'\s;]+)[^"']*["'][^>]*http-equiv\s*=\s*["']content-type["']/i)?.[1];
  return normalizeCharset(contentTypeMeta);
}

function inferCharset(contentType: string, bytes: Uint8Array): string {
  const headerCharset = normalizeCharset(contentType.match(/charset\s*=\s*([^;]+)/i)?.[1]);
  if (headerCharset) return headerCharset;

  const headPreview = new TextDecoder("utf-8").decode(bytes.slice(0, HEAD_DECODE_BYTES));
  return inferCharsetFromHtmlPreview(headPreview) ?? "utf-8";
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = inferCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function extractBodyHtml(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function getAttribute(tag: string, attributeName: "class" | "id"): string {
  const match = tag.match(new RegExp(`${attributeName}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"));
  return match ? decodeHtmlAttribute(match[2] ?? "") : "";
}

function trimCandidateText(value: string): { text: string; truncated: boolean } {
  return trimWithLimit(value, 2_400, 2_400);
}

function extractJsonLdArticleBodies(html: string): Array<{ source: string; text: string }> {
  const candidates: Array<{ source: string; text: string }> = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = htmlToText(match[2] ?? "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const body of findJsonArticleBodies(parsed)) {
        candidates.push({ source: "json-ld:articleBody", text: body });
      }
    } catch {
      for (const bodyMatch of raw.matchAll(/"articleBody"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/gi)) {
        const body = bodyMatch[1]?.replace(/\\"/g, "\"").replace(/\\n/g, "\n");
        if (body) candidates.push({ source: "json-ld:articleBody", text: body });
      }
    }
  }
  return candidates;
}

function findJsonArticleBodies(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findJsonArticleBodies);
  const record = value as Record<string, unknown>;
  const bodies: string[] = [];
  if (typeof record.articleBody === "string" && record.articleBody.trim()) {
    bodies.push(record.articleBody.trim());
  }
  for (const nested of Object.values(record)) {
    bodies.push(...findJsonArticleBodies(nested));
  }
  return bodies;
}

function collectParagraphCluster(html: string): Array<{ source: string; text: string }> {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/gi)]
    .map((match) => htmlToText(match[0] ?? ""))
    .map((text) => text.trim())
    .filter((text) => text.length >= 8);
  if (paragraphs.length < 2) return [];

  const clusters: string[][] = [];
  let current: string[] = [];
  for (const paragraph of paragraphs) {
    const isNoise = /^(APP|微信|下载|举报|评论|分享到|来源[:：]?\s*$|责任编辑[:：]?)/i.test(paragraph)
      || /客户端|公众号|二维码|ICP备案|版权|未经授权/.test(paragraph);
    if (isNoise) {
      if (current.length > 0) clusters.push(current);
      current = [];
      continue;
    }
    current.push(paragraph);
  }
  if (current.length > 0) clusters.push(current);

  return clusters
    .map((cluster, index) => ({ source: `paragraph_cluster:${index + 1}`, text: cluster.join("\n\n") }))
    .filter((candidate) => candidate.text.length > 120);
}

function collectReadableCandidates(html: string): Array<{ source: string; text: string }> {
  const candidates: Array<{ source: string; text: string }> = [];
  const body = extractBodyHtml(html);
  candidates.push(...extractJsonLdArticleBodies(html));
  const structuralPatterns = [
    { source: "article", pattern: /<article\b[^>]*>[\s\S]*?<\/article>/gi },
    { source: "main", pattern: /<main\b[^>]*>[\s\S]*?<\/main>/gi },
  ];
  for (const { source, pattern } of structuralPatterns) {
    for (const match of body.matchAll(pattern)) {
      if (match[0]) candidates.push({ source, text: match[0] });
    }
  }

  const contentLike =
    /(article|content|detail|details|main|news|post|entry|body|text|txt|rich|paragraph|TRS_Editor|正文|内容|稿件|文章|新闻)/i;
  for (const match of body.matchAll(/<(div|section|td)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    const block = match[0] ?? "";
    const openingTag = block.match(/^<[^>]+>/)?.[0] ?? "";
    const marker = `${getAttribute(openingTag, "id")} ${getAttribute(openingTag, "class")}`;
    if (contentLike.test(marker)) candidates.push({ source: marker.trim() || "content-like-block", text: block });
  }

  candidates.push(...collectParagraphCluster(body));
  candidates.push({ source: "whole_body", text: body });
  return candidates
    .map((candidate) => ({ ...candidate, text: htmlToText(candidate.text) }))
    .filter((candidate) => candidate.text.trim());
}

function scoreReadableText(text: string, title?: string): number {
  const lengthScore = Math.min(text.length, 20_000) / 100;
  const punctuationScore = (text.match(/[。！？；：，、.!?;:,]/g)?.length ?? 0) * 4;
  const paragraphScore = (text.match(/\n\s*\n/g)?.length ?? 0) * 8;
  const titleScore = title && text.includes(title) ? 120 : 0;
  const navPenalty = (text.match(/下载|扫码|客户端|关注|举报|评论|相关新闻|热点新闻|热新闻|进入频道|版权所有|ICP备案/g)?.length ?? 0) * 18;
  return lengthScore + punctuationScore + paragraphScore + titleScore - navPenalty;
}

function candidateSourceBoost(source: string): number {
  if (source.startsWith("json-ld:articleBody")) return 260;
  if (source.startsWith("paragraph_cluster")) return 180;
  if (source === "article") return 160;
  if (source === "main") return 110;
  if (source === "whole_body") return -140;
  return 80;
}

function stripBoilerplateLines(text: string): string {
  const noisyLine =
    /^(APP|微信|举报|更多|>|<|-+>|扫码查看|全文播报|进入频道|我要评论|查看更多评论|打开|关闭|取消|关注我们|精彩评论\s*\d*|天\s+周\s+月)$/;
  const noisyContains =
    /下载.*客户端|建议使用浏览器扫码下载|违法和不良信息举报中心|版权所有|Copyright|ICP备|许可证|跟帖评论自律管理承诺书|扫描或长按关注/;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !noisyLine.test(line) && !noisyContains.test(line))
    .join("\n");
}

function focusArticleText(text: string, title?: string): string {
  let focused = normalizeText(stripBoilerplateLines(text));
  if (title) {
    const first = focused.indexOf(title);
    const second = first >= 0 ? focused.indexOf(title, first + title.length) : -1;
    const start = second >= 0 ? second : first;
    if (start >= 0) focused = focused.slice(start).trim();
  }

  const stopMarkers = [
    "未经授权，严禁转载",
    "打开川观新闻，阅读全文",
    "精彩评论",
    "相关新闻",
    "热新闻",
    "关注我们",
  ];
  for (const marker of stopMarkers) {
    const index = focused.indexOf(marker);
    if (index > 80) {
      focused = focused.slice(0, index).trim();
    }
  }
  return focused;
}

function extractReadableHtml(html: string): ExtractedReadableHtml {
  const title = extractTitle(html);
  const candidates = collectReadableCandidates(html);
  const rankedCandidates = candidates
    .map((candidate) => {
      const focused = focusArticleText(candidate.text, title);
      return {
        source: candidate.source,
        score: scoreReadableText(focused, title) + candidateSourceBoost(candidate.source),
        text: focused,
      };
    })
    .filter((candidate) => candidate.text.length > 80)
    .sort((a, b) => b.score - a.score);
  const best = rankedCandidates[0]?.text ?? focusArticleText(htmlToText(extractBodyHtml(html)), title);
  const articleCandidates = rankedCandidates.slice(0, 5).map((candidate) => {
    const trimmed = trimCandidateText(candidate.text);
    return {
      source: candidate.source,
      score: Math.round(candidate.score),
      text: trimmed.text,
      truncated: trimmed.truncated,
    };
  });
  const strategy = rankedCandidates.length > 0 ? "article_candidate" : "whole_body";
  return {
    text: best,
    articleCandidates,
    extraction: {
      strategy,
      candidateCount: rankedCandidates.length,
      needsModelReview: articleCandidates.length > 1 || /扫码|APP|下载|评论|举报|客户端/.test(best),
      hint: "Model should review articleCandidates and choose the block that best matches the user's requested page/article body. If text contains navigation, app download, comment, or footer boilerplate, prefer a cleaner candidate.",
    },
  };
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ShiguangAgent/1.0",
        Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
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
      const rawBytes = new Uint8Array(await response.arrayBuffer());
      const raw = decodeBody(rawBytes, contentType);
      if (!response.ok) {
        throw new Error(`web_fetch failed: ${response.status} ${response.statusText} - ${raw.slice(0, 300)}`);
      }
      const isHtml = /html/i.test(contentType) || /<!doctype html|<html[\s>]/i.test(raw.slice(0, 500));
      const extracted = isHtml ? extractReadableHtml(raw) : null;
      const readable = extracted ? extracted.text : raw.trim();
      const limited = trimText(readable, parsed.maxChars ?? MAX_TEXT_CHARS);
      const htmlFields = isHtml ? trimHtmlPreview(raw) : {};
      return {
        url: url.toString(),
        status: response.status,
        contentType,
        title: isHtml ? extractTitle(raw) : undefined,
        text: limited.text,
        truncated: limited.truncated,
        ...(extracted
          ? {
              articleCandidates: extracted.articleCandidates,
              extraction: extracted.extraction,
            }
          : {}),
        ...htmlFields,
      };
    },
  };
}

import { connect } from "node:net";
import { ProxyAgent } from "undici";

const COMMON_LOCAL_PROXY_PORTS = [7897, 7890, 7891, 7892, 7893, 7899, 1080, 10808, 20171];
const LOCAL_PROXY_HOST = "127.0.0.1";
const PROXY_DETECT_TIMEOUT_MS = 120;

const proxyAgents = new Map<string, ProxyAgent>();
let detectedProxyURL: string | null | undefined;

interface FetchInitWithDispatcher extends RequestInit {
  dispatcher?: ProxyAgent;
}

export async function fetchWithNetworkProxy(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = url.toString();
  const proxyURL = await resolveProxyURL(target);
  const dispatcher = proxyURL ? getProxyAgent(proxyURL) : undefined;

  try {
    return await fetch(url, dispatcher ? { ...init, dispatcher } as FetchInitWithDispatcher : init);
  } catch (error) {
    throw improveFetchError(error, target, proxyURL);
  }
}

async function resolveProxyURL(target: string): Promise<string | null> {
  if (shouldBypassProxy(target)) return null;

  const explicit = normalizeProxyURL(process.env.SHIGUANG_PROXY_URL);
  if (explicit !== undefined) return explicit;

  const envProxy = normalizeProxyURL(
    process.env.HTTPS_PROXY
      ?? process.env.HTTP_PROXY
      ?? process.env.ALL_PROXY
      ?? process.env.https_proxy
      ?? process.env.http_proxy
      ?? process.env.all_proxy,
  );
  if (envProxy !== undefined) return envProxy;

  if (process.env.SHIGUANG_PROXY_AUTO === "0") return null;
  return detectLocalProxy();
}

function normalizeProxyURL(value: string | undefined): string | null | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^(direct|none|off|false)$/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `http://${LOCAL_PROXY_HOST}:${trimmed}`;
  if (/^[\w.-]+:\d+$/.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

async function detectLocalProxy(): Promise<string | null> {
  if (detectedProxyURL !== undefined) return detectedProxyURL;

  for (const port of COMMON_LOCAL_PROXY_PORTS) {
    if (await canConnect(LOCAL_PROXY_HOST, port, PROXY_DETECT_TIMEOUT_MS)) {
      detectedProxyURL = `http://${LOCAL_PROXY_HOST}:${port}`;
      return detectedProxyURL;
    }
  }

  detectedProxyURL = null;
  return null;
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function getProxyAgent(proxyURL: string): ProxyAgent {
  const existing = proxyAgents.get(proxyURL);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyURL);
  proxyAgents.set(proxyURL, agent);
  return agent;
}

function shouldBypassProxy(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (matchesNoProxy(host)) return true;
  return false;
}

function matchesNoProxy(host: string): boolean {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  return noProxy
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule === "*") return true;
      if (rule.startsWith(".")) return host.endsWith(rule);
      return host === rule || host.endsWith(`.${rule}`);
    });
}

function improveFetchError(error: unknown, target: string, proxyURL: string | null): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const message = [error.message, causeText].filter(Boolean).join(": ");
  const fakeIpHint = /\b198\.18\./.test(message)
    ? " Detected a 198.18.x.x Fake-IP address; enable Clash/Mihomo TUN routing for this app or set SHIGUANG_PROXY_URL."
    : "";
  const proxyHint = proxyURL
    ? ` Proxy used: ${proxyURL}.`
    : " No explicit proxy was available. Try SHIGUANG_PROXY_URL=http://127.0.0.1:7897.";

  return new Error(`Network request failed for ${target}: ${message}.${fakeIpHint}${proxyHint}`);
}

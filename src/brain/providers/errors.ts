export function formatProviderFetchError(provider: string, url: string, error: unknown): Error {
  if (isAbortError(error)) {
    return error instanceof Error ? error : new Error("模型请求已取消。");
  }

  const message = error instanceof Error ? error.message : String(error);
  const endpoint = summarizeEndpoint(url);
  const proxyHint = summarizeProxy();
  const diagnosis = diagnoseNetworkMessage(message);

  return new Error([
    `${provider} 网络请求失败：无法连接 ${endpoint}。`,
    diagnosis,
    proxyHint,
    `底层错误：${message}`,
  ].filter(Boolean).join(" "));
}

export function formatProviderHttpError(provider: string, status: number, text: string): Error {
  const detail = text.trim().slice(0, 500) || "服务端没有返回错误详情。";
  const hint = status === 401 || status === 403
    ? "请检查 API Key、余额、权限和当前 provider/model 是否匹配。"
    : status === 404
      ? "请检查 Base URL 是否包含正确的 /v1 路径，以及模型名称是否存在。"
      : status === 429
        ? "请求被限流或额度不足，请稍后重试，或切换 provider/model。"
        : status >= 500
          ? "服务商当前可能不可用，请稍后重试；如果你走代理，也可以先关闭代理或换节点测试。"
          : "请检查 provider 配置、模型名称、Base URL 和请求额度。";

  return new Error(`${provider} API 返回 ${status}：${hint} 原始响应：${detail}`);
}

export function formatProviderEmptyResponse(provider: string): Error {
  return new Error(`${provider} 返回了空响应：模型服务连通了，但没有给出可解析内容。请检查模型名是否支持 Chat/JSON 输出，或换一个稳定模型后重试。`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled/i.test(error.message));
}

function summarizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function summarizeProxy(): string {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY;
  if (proxy?.trim()) {
    return `检测到当前进程配置了代理 ${redactProxy(proxy)}；如果你已经开 TUN/系统代理但仍失败，优先确认该端口可用，或临时关闭代理再试。`;
  }
  return "如果你在国内网络环境，可能需要可用代理；如果已经开了代理/TUN，请确认 Electron 进程也能访问该代理。";
}

function redactProxy(proxy: string): string {
  try {
    const parsed = new URL(proxy);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return proxy.replace(/\/\/([^:@\s]+):([^@\s]+)@/, "//***:***@");
  }
}

function diagnoseNetworkMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("client network socket disconnected") || lower.includes("tls")) {
    return "连接在 TLS 握手前断开，常见原因是代理端口不可用、节点拦截 HTTPS、证书/系统网络栈异常。";
  }
  if (lower.includes("econnrefused")) {
    return "目标端口拒绝连接，常见原因是代理软件没启动、端口写错，或 Base URL 指到了本地但服务没开。";
  }
  if (lower.includes("enotfound") || lower.includes("dns")) {
    return "域名解析失败，常见原因是 DNS/代理规则没有命中，或 Base URL 拼写错误。";
  }
  if (lower.includes("etimedout") || lower.includes("timeout")) {
    return "连接超时，常见原因是服务商不可达、代理节点慢，或网络被拦截。";
  }
  if (lower.includes("fetch failed")) {
    return "底层 fetch 失败，通常是网络、代理或 TLS 连接问题，不是 Agent 工具循环问题。";
  }
  return "这通常是网络、代理、TLS 或 Base URL 配置问题。";
}

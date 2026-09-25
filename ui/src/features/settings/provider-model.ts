import type { DesktopSessionLlmSettings, DesktopSettings, ToolApprovalMode } from "../../bridge";

export type SettingsTone = "neutral" | "success" | "warn" | "danger" | "accent";

export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
export type ProviderAuthMode = "api_key" | "none";
export type ProviderDraft = {
  key: string;
  type: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseURL: string;
  apiKey: string;
  apiKeyMasked: string;
  hasStoredApiKey: boolean;
  apiKeyEnv: string;
  model: string;
  maxTokens: string;
};

export type ProviderModelOption = {
  label: string;
  value: string;
  hint: string;
};

export type ComposerModelOption = {
  label: string;
  value: string;
  hint: string;
  provider: string;
  model: string;
  maxTokens?: number;
};

export const CODEX_PROVIDER_HINT = "先做 Hermes 风格 API provider registry：Codex 目前走 OpenAI API 模式，不走 CLI/OAuth 登录态；其他兼容 Chat Completions 的 provider 也一样接。";

export const PROVIDER_PRESETS: ProviderDraft[] = [
  { key: "deepseek", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.deepseek.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash", maxTokens: "4096" },
  { key: "openai", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "codex-api", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "openrouter", type: "openai-compatible", authMode: "api_key", baseURL: "https://openrouter.ai/api/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-5", maxTokens: "4096" },
  { key: "anthropic", type: "anthropic", authMode: "api_key", baseURL: "https://api.anthropic.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-3-5-sonnet-latest", maxTokens: "4096" },
  { key: "gemini", type: "gemini", authMode: "api_key", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", maxTokens: "4096" },
  { key: "ollama", type: "openai-compatible", authMode: "none", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "", model: "qwen2.5-coder:14b", maxTokens: "4096" },
];

export const DEEPSEEK_MODEL_OPTIONS: ProviderModelOption[] = [
  { label: "Flash", value: "deepseek-v4-flash", hint: "默认推荐，速度/成本更适合日常 Agent" },
  { label: "Pro", value: "deepseek-v4-pro", hint: "更强，适合复杂工程和长任务" },
  { label: "Legacy Chat", value: "deepseek-chat", hint: "旧兼容名，建议逐步切到 Flash" },
  { label: "Legacy Reasoner", value: "deepseek-reasoner", hint: "旧思考兼容名，建议逐步切到 Pro/Flash" },
];

export function findProviderPreset(key: string): ProviderDraft | null {
  return PROVIDER_PRESETS.find((preset) => preset.key === key) ?? null;
}

export function isDeepSeekProvider(key: string, draft: ProviderDraft): boolean {
  return `${key} ${draft.baseURL}`.toLowerCase().includes("deepseek");
}

export function modelOptionsForProvider(key: string, draft: ProviderDraft): ProviderModelOption[] {
  if (isDeepSeekProvider(key, draft)) return DEEPSEEK_MODEL_OPTIONS;
  return [];
}

export function composerModelValue(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export function buildComposerModelOptions(settings: DesktopSettings, activeProvider: string, activeModel: string): ComposerModelOption[] {
  const options: ComposerModelOption[] = [];
  const seen = new Set<string>();

  const pushOption = (provider: string, model: string, label?: string, hint?: string, maxTokens?: number) => {
    const cleanProvider = provider.trim();
    const cleanModel = model.trim();
    if (!cleanProvider || !cleanModel) return;
    const value = composerModelValue(cleanProvider, cleanModel);
    if (seen.has(value)) return;
    seen.add(value);
    options.push({
      provider: cleanProvider,
      model: cleanModel,
      value,
      label: label ?? `${cleanProvider} · ${cleanModel}`,
      hint: hint ?? `当前会话使用 ${cleanProvider} / ${cleanModel}`,
      ...(typeof maxTokens === "number" ? { maxTokens } : {}),
    });
  };

  for (const [provider, rawProvider] of Object.entries(settings.providers ?? {})) {
    const draft = providerDraftFromSettings(settings, provider);
    const presetOptions = modelOptionsForProvider(provider, draft);
    if (presetOptions.length > 0) {
      for (const option of presetOptions) {
        pushOption(provider, option.value, `${provider} · ${option.label}`, option.hint, rawProvider.maxTokens);
      }
    }
    pushOption(provider, draft.model || settings.llm.model || "", undefined, undefined, rawProvider.maxTokens);
  }

  pushOption(activeProvider, activeModel);
  return options;
}

export function providerDraftFromSettings(settings: DesktopSettings, key: string): ProviderDraft {
  const provider = settings.providers[key] ?? {};
  return {
    key,
    type: provider.type ?? "openai-compatible",
    authMode: provider.authMode ?? "api_key",
    baseURL: provider.baseURL ?? "",
    apiKey: provider.authMode === "none" ? (provider.apiKey ?? "") : "",
    apiKeyMasked: provider.apiKeyMasked ?? "",
    hasStoredApiKey: Boolean(provider.hasStoredApiKey),
    apiKeyEnv: provider.apiKeyEnv ?? "",
    model: provider.model ?? "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
  };
}

export function createProviderDraft(key: string): ProviderDraft {
  return {
    key,
    type: "openai-compatible",
    authMode: "api_key",
    baseURL: "",
    apiKey: "",
    apiKeyMasked: "",
    hasStoredApiKey: false,
    apiKeyEnv: "",
    model: "",
    maxTokens: "",
  };
}

export function providerCatalogFromSettings(settings: DesktopSettings): Record<string, ProviderDraft> {
  const keys = Object.keys(settings.providers ?? {});
  const providerKeys = keys.length > 0 ? keys : [settings.llm.provider ?? "openai"];
  return Object.fromEntries(providerKeys.map((key) => [key, providerDraftFromSettings(settings, key)]));
}

export function buildProviderSettings(draft: ProviderDraft): DesktopSettings["providers"][string] {
  const parsedMaxTokens = draft.maxTokens.trim() ? Number.parseInt(draft.maxTokens, 10) : undefined;
  return {
    type: draft.type,
    authMode: draft.authMode,
    ...(draft.baseURL.trim() ? { baseURL: draft.baseURL.trim() } : {}),
    ...(draft.authMode !== "none" && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.authMode !== "none" && draft.hasStoredApiKey ? { hasStoredApiKey: true } : {}),
    ...(draft.authMode !== "none" && draft.hasStoredApiKey && draft.apiKeyMasked ? { apiKeyMasked: draft.apiKeyMasked } : {}),
    ...(draft.authMode !== "none" && draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
    ...(draft.authMode === "none" && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
  };
}

export function buildSettings(
  base: DesktopSettings,
  providerCatalog: Record<string, ProviderDraft>,
  workspaceRoot: string,
  activeProvider: string,
  activeModel: string,
  maxTokens: string,
  toolApprovalMode: ToolApprovalMode,
  executionPreset: DesktopSettings["executionPreset"],
): DesktopSettings {
  const parsedMaxTokens = maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined;
  const nextProviders = Object.fromEntries(
    Object.entries(providerCatalog).map(([key, draft]) => [key, buildProviderSettings(draft)]),
  );

  return {
    ...base,
    workspaceRoot: workspaceRoot.trim(),
    toolApprovalMode,
    executionPreset,
    llm: {
      provider: activeProvider.trim() || "openai",
      ...(activeModel.trim() ? { model: activeModel.trim() } : {}),
      ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
    },
    providers: nextProviders,
  };
}

export function buildSessionLlmSettings(provider: string, model: string, maxTokens: string | number | undefined): DesktopSessionLlmSettings | null {
  const cleanProvider = provider.trim();
  const cleanModel = typeof model === "string" ? model.trim() : "";
  const parsedMaxTokens = typeof maxTokens === "number" ? maxTokens : Number.parseInt(String(maxTokens ?? ""), 10);
  const normalizedMaxTokens = Number.isFinite(parsedMaxTokens)
    ? Math.max(256, Math.min(128000, Math.floor(parsedMaxTokens)))
    : undefined;
  const llm: DesktopSessionLlmSettings = {
    ...(cleanProvider ? { provider: cleanProvider } : {}),
    ...(cleanModel ? { model: cleanModel } : {}),
    ...(normalizedMaxTokens ? { maxTokens: normalizedMaxTokens } : {}),
  };
  return Object.keys(llm).length > 0 ? llm : null;
}

export function formatMcpServersJson(servers: DesktopSettings["mcpServers"] | undefined): string {
  return JSON.stringify(servers ?? {}, null, 2);
}

export function parseMcpServersJson(value: string): DesktopSettings["mcpServers"] {
  const text = value.trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP Servers 必须是一个 JSON 对象");
  }
  return parsed as DesktopSettings["mcpServers"];
}

export function providerTone(draft: ProviderDraft): SettingsTone {
  if (draft.authMode === "none") return "accent";
  if (draft.apiKey.trim()) return "warn";
  if (draft.hasStoredApiKey) return "success";
  if (draft.apiKeyEnv.trim()) return "warn";
  return "neutral";
}

export function providerLabel(draft: ProviderDraft): string {
  if (draft.authMode === "none") return "免鉴权";
  if (draft.apiKey.trim()) return "新 Key";
  if (draft.hasStoredApiKey) return "已存 Key";
  if (draft.apiKeyEnv.trim()) return "环境变量";
  return "未配置";
}

export function uniqueProviderKey(existingKeys: string[], baseKey: string): string {
  const normalized = baseKey.trim() || "provider";
  if (!existingKeys.includes(normalized)) return normalized;
  let index = 2;
  while (existingKeys.includes(`${normalized}-${index}`)) {
    index += 1;
  }
  return `${normalized}-${index}`;
}

export function normalizeProviderDraftForCompare(draft: ProviderDraft) {
  return {
    key: draft.key,
    type: draft.type,
    authMode: draft.authMode,
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey.trim(),
    apiKeyMasked: draft.apiKeyMasked,
    hasStoredApiKey: draft.hasStoredApiKey,
    apiKeyEnv: draft.apiKeyEnv.trim(),
    model: draft.model.trim(),
    maxTokens: draft.maxTokens.trim(),
  };
}

export function formatSettingsValue(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : "—";
}

export function normalizePathDisplayValue(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

export function sameDisplayPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePathDisplayValue(a);
  const right = normalizePathDisplayValue(b);
  return left.length > 0 && left === right;
}

export function compactPathTail(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "未设置";
  const parts = normalized.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[0] ?? normalized;
}

export function isHiddenSessionWorkspace(value: string | null | undefined): boolean {
  return /[\\\/]\.shiguang[\\\/]sessions[\\\/]sess_/i.test(value ?? "");
}

export function toolApprovalModeLabel(mode: ToolApprovalMode | undefined): string {
  return mode === "workspace_edits" ? "自动批准工作区文件编辑" : "写文件前需要审批";
}

export function summarizeApiKeySource(draft: ProviderDraft): string {
  if (draft.authMode === "none") return "免鉴权";
  if (draft.apiKey.trim()) return "面板新 Key";
  if (draft.hasStoredApiKey) return draft.apiKeyMasked ? `本地已存 ${draft.apiKeyMasked}` : "本地已存 Key";
  if (draft.apiKeyEnv.trim()) return `环境变量 ${draft.apiKeyEnv.trim()}`;
  return "缺失";
}

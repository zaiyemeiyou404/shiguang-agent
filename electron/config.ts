import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 2048;

export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
export type ProviderAuthMode = "api_key" | "none";

interface ProviderConfigFile {
  type?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  maxTokens?: number;
}

interface LlmConfigFile extends ProviderConfigFile {
  provider?: string;
}

interface DesktopConfigFile {
  workspaceRoot?: string;
  llm?: LlmConfigFile;
  providers?: Record<string, ProviderConfigFile>;
}

export interface ResolvedLlmConfig {
  provider: string;
  providerType: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface ResolvedDesktopConfig {
  configPath: string;
  workspaceRoot: string;
  llm: ResolvedLlmConfig;
}

export interface DesktopProviderSettings {
  type?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  baseURL?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  hasStoredApiKey?: boolean;
  apiKeyEnv?: string;
  model?: string;
  maxTokens?: number;
}

export interface DesktopSettings {
  configPath: string;
  workspaceRoot: string;
  llm: {
    provider: string;
    model?: string;
    maxTokens?: number;
  };
  providers: Record<string, DesktopProviderSettings>;
}

function defaultProviderCatalog(): Record<string, DesktopProviderSettings> {
  return {
    deepseek: {
      type: "openai-compatible",
      authMode: "api_key",
      baseURL: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-chat",
      maxTokens: 4096,
    },
    openai: {
      type: "openai-compatible",
      authMode: "api_key",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-5",
      maxTokens: 4096,
    },
    "codex-api": {
      type: "openai-compatible",
      authMode: "api_key",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-5",
      maxTokens: 4096,
    },
    openrouter: {
      type: "openai-compatible",
      authMode: "api_key",
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      model: "openai/gpt-5",
      maxTokens: 4096,
    },
    siliconflow: {
      type: "openai-compatible",
      authMode: "api_key",
      baseURL: "https://api.siliconflow.cn/v1",
      apiKeyEnv: "SILICONFLOW_API_KEY",
      model: "deepseek-ai/DeepSeek-V3",
      maxTokens: 4096,
    },
    ollama: {
      type: "openai-compatible",
      authMode: "none",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen2.5-coder:14b",
      maxTokens: 4096,
    },
    anthropic: {
      type: "anthropic",
      authMode: "api_key",
      baseURL: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      model: "claude-3-5-sonnet-latest",
      maxTokens: 4096,
    },
    gemini: {
      type: "gemini",
      authMode: "api_key",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: "GEMINI_API_KEY",
      model: "gemini-2.5-pro",
      maxTokens: 4096,
    },
  };
}

function mergeProviderCatalog(fileProviders?: Record<string, ProviderConfigFile>): Record<string, DesktopProviderSettings> {
  return {
    ...defaultProviderCatalog(),
    ...(fileProviders ?? {}),
  };
}

export function getDesktopConfigPath(): string {
  return process.env.SHIGUANG_CONFIG_PATH
    ? resolve(process.env.SHIGUANG_CONFIG_PATH)
    : join(app.getPath("userData"), "shiguang.config.json");
}

export function loadDesktopConfig(): ResolvedDesktopConfig {
  const configPath = getDesktopConfigPath();
  const fileConfig = readConfigFile(configPath);
  const providerName = process.env.SHIGUANG_LLM_PROVIDER
    ?? fileConfig.llm?.provider
    ?? "openai";
  const providerCatalog = mergeProviderCatalog(fileConfig.providers);
  const providerConfig = providerCatalog[providerName] ?? {};
  const providerType = normalizeProviderProtocol(providerConfig.type ?? fileConfig.llm?.type);
  const authMode = providerConfig.authMode ?? fileConfig.llm?.authMode ?? "api_key";

  const llm: ResolvedLlmConfig = {
    provider: providerName,
    providerType,
    authMode,
    baseURL: normalizeBaseURL(
      process.env.SHIGUANG_LLM_BASE_URL
      ?? providerConfig.baseURL
      ?? fileConfig.llm?.baseURL
      ?? DEFAULT_BASE_URL,
    ),
    apiKey: authMode === "none"
      ? providerConfig.apiKey ?? ""
      : process.env.SHIGUANG_LLM_API_KEY
        ?? readProviderApiKey(providerConfig)
        ?? fileConfig.llm?.apiKey
        ?? "",
    model: process.env.SHIGUANG_LLM_MODEL
      ?? fileConfig.llm?.model
      ?? providerConfig.model
      ?? DEFAULT_MODEL,
    maxTokens: normalizeMaxTokens(
      process.env.SHIGUANG_LLM_MAX_TOKENS
      ?? fileConfig.llm?.maxTokens
      ?? providerConfig.maxTokens
      ?? DEFAULT_MAX_TOKENS,
    ),
  };

  const workspaceRoot = resolve(normalize(
    process.env.SHIGUANG_WORKSPACE_ROOT
    ?? fileConfig.workspaceRoot
    ?? process.cwd(),
  ));

  return { configPath, workspaceRoot, llm };
}

export function getDesktopSettings(): DesktopSettings {
  const configPath = getDesktopConfigPath();
  const fileConfig = readConfigFile(configPath);
  return {
    configPath,
    workspaceRoot: fileConfig.workspaceRoot ?? process.cwd(),
    llm: {
      provider: fileConfig.llm?.provider ?? "openai",
      ...(fileConfig.llm?.model ? { model: fileConfig.llm.model } : {}),
      ...(typeof fileConfig.llm?.maxTokens === "number" ? { maxTokens: fileConfig.llm.maxTokens } : {}),
    },
    providers: sanitizeDesktopProviderCatalog(mergeProviderCatalog(fileConfig.providers)),
  };
}

export function saveDesktopSettings(settings: DesktopSettings): DesktopSettings {
  ensureDesktopConfigDirectory();
  const configPath = getDesktopConfigPath();
  const previousConfig = readConfigFile(configPath);
  const nextConfig: DesktopConfigFile = {
    workspaceRoot: settings.workspaceRoot,
    llm: {
      provider: settings.llm.provider,
      ...(settings.llm.model ? { model: settings.llm.model } : {}),
      ...(typeof settings.llm.maxTokens === "number" ? { maxTokens: settings.llm.maxTokens } : {}),
    },
    providers: buildConfigProvidersForSave(settings.providers, previousConfig.providers),
  };
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return getDesktopSettings();
}

export function getStoredProviderApiKey(providerKey: string): string {
  const configPath = getDesktopConfigPath();
  const fileConfig = readConfigFile(configPath);
  return fileConfig.providers?.[providerKey]?.apiKey?.trim() ?? "";
}

function readConfigFile(configPath: string): DesktopConfigFile {
  if (!existsSync(configPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    return isDesktopConfigFile(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isDesktopConfigFile(value: unknown): value is DesktopConfigFile {
  return typeof value === "object" && value !== null;
}

function readProviderApiKey(providerConfig: ProviderConfigFile | undefined): string | undefined {
  if (!providerConfig) return undefined;
  if (providerConfig.apiKeyEnv) {
    const envValue = process.env[providerConfig.apiKeyEnv];
    if (envValue) return envValue;
  }
  return providerConfig.apiKey;
}

function sanitizeDesktopProviderCatalog(catalog: Record<string, DesktopProviderSettings>): Record<string, DesktopProviderSettings> {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, provider]) => [key, sanitizeDesktopProviderSettings(provider)]),
  );
}

function sanitizeDesktopProviderSettings(provider: DesktopProviderSettings): DesktopProviderSettings {
  const storedApiKey = provider.authMode === "none" ? (provider.apiKey ?? "") : "";
  const hasStoredApiKey = provider.authMode !== "none" && Boolean(provider.apiKey?.trim());
  return {
    ...provider,
    apiKey: storedApiKey,
    ...(hasStoredApiKey ? { apiKeyMasked: maskApiKey(provider.apiKey ?? ""), hasStoredApiKey: true } : {}),
  };
}

function buildConfigProvidersForSave(
  providers: Record<string, DesktopProviderSettings>,
  previousProviders?: Record<string, ProviderConfigFile>,
): Record<string, ProviderConfigFile> {
  return Object.fromEntries(
    Object.entries(providers).map(([key, provider]) => {
      const previousProvider = previousProviders?.[key];
      const nextApiKey = provider.apiKey?.trim();
      const preservedApiKey = !nextApiKey && provider.hasStoredApiKey ? previousProvider?.apiKey?.trim() : undefined;
      return [
        key,
        {
          ...(provider.type ? { type: provider.type } : {}),
          ...(provider.authMode ? { authMode: provider.authMode } : {}),
          ...(provider.baseURL?.trim() ? { baseURL: provider.baseURL.trim() } : {}),
          ...((provider.authMode === "none"
            ? (nextApiKey ? { apiKey: nextApiKey } : {})
            : (nextApiKey ? { apiKey: nextApiKey } : preservedApiKey ? { apiKey: preservedApiKey } : {}))),
          ...(provider.apiKeyEnv?.trim() ? { apiKeyEnv: provider.apiKeyEnv.trim() } : {}),
          ...(provider.model?.trim() ? { model: provider.model.trim() } : {}),
          ...(typeof provider.maxTokens === "number" ? { maxTokens: provider.maxTokens } : {}),
        } satisfies ProviderConfigFile,
      ];
    }),
  );
}

function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${"•".repeat(Math.min(8, Math.max(4, trimmed.length - 4)))}${trimmed.slice(-4)}`;
}

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeProviderProtocol(value: ProviderProtocol | undefined): ProviderProtocol {
  if (value === "anthropic" || value === "gemini" || value === "openai-compatible") {
    return value;
  }
  return "openai-compatible";
}

function normalizeMaxTokens(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOKENS;
  return Math.trunc(parsed);
}

export function ensureDesktopConfigDirectory(): void {
  const configPath = getDesktopConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

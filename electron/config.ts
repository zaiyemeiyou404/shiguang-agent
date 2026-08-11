import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TOOL_APPROVAL_MODE = "ask";

export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
export type ProviderAuthMode = "api_key" | "none";
export type ToolApprovalMode = "ask" | "workspace_edits";

interface ProviderConfigFile {
  type?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  baseURL?: string;
  apiKey?: string;
  encryptedApiKey?: string;
  apiKeyStorage?: "safeStorage" | "plain";
  apiKeyEnv?: string;
  model?: string;
  maxTokens?: number;
}

interface LlmConfigFile extends ProviderConfigFile {
  provider?: string;
}

interface DesktopConfigFile {
  workspaceRoot?: string;
  toolApprovalMode?: ToolApprovalMode;
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
  toolApprovalMode: ToolApprovalMode;
  llm: ResolvedLlmConfig;
}

export interface DesktopProviderSettings {
  type?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  baseURL?: string;
  apiKey?: string;
  encryptedApiKey?: string;
  apiKeyStorage?: "safeStorage" | "plain";
  apiKeyMasked?: string;
  hasStoredApiKey?: boolean;
  apiKeyEnv?: string;
  model?: string;
  maxTokens?: number;
}

export interface DesktopSettings {
  configPath: string;
  workspaceRoot: string;
  toolApprovalMode: ToolApprovalMode;
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
  const fileConfig = readMigratedConfigFile(configPath);
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
        ?? readStoredProviderApiKey(fileConfig.llm)
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

  return {
    configPath,
    workspaceRoot,
    toolApprovalMode: normalizeToolApprovalMode(fileConfig.toolApprovalMode),
    llm,
  };
}

export function getDesktopSettings(): DesktopSettings {
  const configPath = getDesktopConfigPath();
  const fileConfig = readMigratedConfigFile(configPath);
  return {
    configPath,
    workspaceRoot: fileConfig.workspaceRoot ?? process.cwd(),
    toolApprovalMode: normalizeToolApprovalMode(fileConfig.toolApprovalMode),
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
  const previousConfig = readMigratedConfigFile(configPath);
  const nextConfig: DesktopConfigFile = {
    workspaceRoot: settings.workspaceRoot,
    toolApprovalMode: normalizeToolApprovalMode(settings.toolApprovalMode),
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
  const fileConfig = readMigratedConfigFile(configPath);
  return readStoredProviderApiKey(fileConfig.providers?.[providerKey]) ?? "";
}

function readMigratedConfigFile(configPath: string): DesktopConfigFile {
  const fileConfig = readConfigFile(configPath);
  if (!existsSync(configPath)) return fileConfig;

  const migration = migratePlaintextSecrets(fileConfig);
  if (migration.changed) {
    writeFileSync(configPath, `${JSON.stringify(migration.config, null, 2)}\n`, "utf8");
  }
  return migration.config;
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
  return readStoredProviderApiKey(providerConfig);
}

function sanitizeDesktopProviderCatalog(catalog: Record<string, DesktopProviderSettings>): Record<string, DesktopProviderSettings> {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, provider]) => [key, sanitizeDesktopProviderSettings(provider)]),
  );
}

function sanitizeDesktopProviderSettings(provider: DesktopProviderSettings): DesktopProviderSettings {
  const storedApiKey = provider.authMode === "none" ? (provider.apiKey ?? "") : readStoredProviderApiKey(provider);
  const hasStoredApiKey = provider.authMode !== "none" && Boolean(storedApiKey?.trim());
  const { encryptedApiKey: _encryptedApiKey, apiKeyStorage: _apiKeyStorage, ...publicProvider } = provider;
  return {
    ...publicProvider,
    apiKey: storedApiKey,
    ...(provider.authMode !== "none" ? { apiKey: "" } : {}),
    ...(hasStoredApiKey ? { apiKeyMasked: maskApiKey(storedApiKey ?? ""), hasStoredApiKey: true } : {}),
  };
}

function buildConfigProvidersForSave(
  providers: Record<string, DesktopProviderSettings>,
  previousProviders?: Record<string, ProviderConfigFile>,
): Record<string, ProviderConfigFile> {
  return Object.fromEntries(
    Object.entries(providers).map(([key, provider]) => {
      const previousProvider = previousProviders?.[key];
      const apiKeyFields = buildApiKeyFieldsForSave(provider, previousProvider);
      return [
        key,
        {
          ...(provider.type ? { type: provider.type } : {}),
          ...(provider.authMode ? { authMode: provider.authMode } : {}),
          ...(provider.baseURL?.trim() ? { baseURL: provider.baseURL.trim() } : {}),
          ...apiKeyFields,
          ...(provider.apiKeyEnv?.trim() ? { apiKeyEnv: provider.apiKeyEnv.trim() } : {}),
          ...(provider.model?.trim() ? { model: provider.model.trim() } : {}),
          ...(typeof provider.maxTokens === "number" ? { maxTokens: provider.maxTokens } : {}),
        } satisfies ProviderConfigFile,
      ];
    }),
  );
}

function buildApiKeyFieldsForSave(
  provider: DesktopProviderSettings,
  previousProvider?: ProviderConfigFile,
): Pick<ProviderConfigFile, "apiKey" | "encryptedApiKey" | "apiKeyStorage"> {
  const nextApiKey = provider.apiKey?.trim();
  if (provider.authMode === "none") {
    return nextApiKey ? { apiKey: nextApiKey } : {};
  }

  if (nextApiKey) {
    return protectApiKeyForConfig(nextApiKey);
  }

  if (!provider.hasStoredApiKey) return {};

  if (previousProvider?.encryptedApiKey) {
    return {
      encryptedApiKey: previousProvider.encryptedApiKey,
      apiKeyStorage: previousProvider.apiKeyStorage ?? "safeStorage",
    };
  }

  const previousApiKey = readStoredProviderApiKey(previousProvider);
  return previousApiKey ? protectApiKeyForConfig(previousApiKey) : {};
}

function migratePlaintextSecrets(config: DesktopConfigFile): { config: DesktopConfigFile; changed: boolean } {
  let changed = false;
  const next: DesktopConfigFile = { ...config };

  if (next.llm) {
    const migrated = migrateProviderSecret(next.llm);
    next.llm = migrated.provider;
    changed = changed || migrated.changed;
  }

  if (next.providers) {
    const providers: Record<string, ProviderConfigFile> = {};
    for (const [key, provider] of Object.entries(next.providers)) {
      const migrated = migrateProviderSecret(provider);
      providers[key] = migrated.provider;
      changed = changed || migrated.changed;
    }
    next.providers = providers;
  }

  return { config: next, changed };
}

function migrateProviderSecret<T extends ProviderConfigFile>(provider: T): { provider: T; changed: boolean } {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey || provider.authMode === "none") {
    return { provider, changed: false };
  }

  const { apiKey: _legacyApiKey, ...rest } = provider;
  return {
    provider: {
      ...rest,
      ...protectApiKeyForConfig(apiKey),
    } as T,
    changed: true,
  };
}

function readStoredProviderApiKey(providerConfig: ProviderConfigFile | undefined): string | undefined {
  if (!providerConfig) return undefined;
  if (providerConfig.encryptedApiKey) {
    const decrypted = decryptApiKeyFromConfig(providerConfig.encryptedApiKey);
    if (decrypted) return decrypted;
  }
  return providerConfig.apiKey?.trim() || undefined;
}

function protectApiKeyForConfig(apiKey: string): Pick<ProviderConfigFile, "apiKey" | "encryptedApiKey" | "apiKeyStorage"> {
  const encryptedApiKey = encryptApiKeyForConfig(apiKey);
  if (encryptedApiKey) {
    return {
      encryptedApiKey,
      apiKeyStorage: "safeStorage",
    };
  }
  return {
    apiKey,
    apiKeyStorage: "plain",
  };
}

function encryptApiKeyForConfig(apiKey: string): string | null {
  if (!canUseSafeStorage()) return null;
  try {
    return safeStorage.encryptString(apiKey).toString("base64");
  } catch {
    return null;
  }
}

function decryptApiKeyFromConfig(value: string): string | null {
  if (!canUseSafeStorage()) return null;
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(value, "base64")).trim();
    return decrypted || null;
  } catch {
    return null;
  }
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
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

function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  return value === "workspace_edits" ? "workspace_edits" : DEFAULT_TOOL_APPROVAL_MODE;
}

export function ensureDesktopConfigDirectory(): void {
  const configPath = getDesktopConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

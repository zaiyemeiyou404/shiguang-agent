import { app } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 2048;

interface ProviderConfigFile {
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
    ?? "openai-compatible";
  const providerConfig = fileConfig.providers?.[providerName];

  const llm: ResolvedLlmConfig = {
    provider: providerName,
    baseURL: normalizeBaseURL(
      process.env.SHIGUANG_LLM_BASE_URL
      ?? providerConfig?.baseURL
      ?? fileConfig.llm?.baseURL
      ?? DEFAULT_BASE_URL,
    ),
    apiKey: process.env.SHIGUANG_LLM_API_KEY
      ?? readProviderApiKey(providerConfig)
      ?? fileConfig.llm?.apiKey
      ?? "",
    model: process.env.SHIGUANG_LLM_MODEL
      ?? fileConfig.llm?.model
      ?? providerConfig?.model
      ?? DEFAULT_MODEL,
    maxTokens: normalizeMaxTokens(
      process.env.SHIGUANG_LLM_MAX_TOKENS
      ?? fileConfig.llm?.maxTokens
      ?? providerConfig?.maxTokens
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

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
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

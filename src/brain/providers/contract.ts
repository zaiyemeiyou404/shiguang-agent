export const PROVIDER_CONTRACT_VERSION = "shiguang.provider.contract.v1" as const;

export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
export type ProviderAuthMode = "api_key" | "none";
export type ProviderRequestMode =
  | "native_tools"
  | "json_object"
  | "plain_json"
  | "anthropic_messages"
  | "gemini_json";
export type ProviderCostClass = "local" | "low" | "medium" | "high" | "unknown";

export interface ProviderCapabilities {
  nativeToolCalling: boolean;
  jsonObjectMode: boolean;
  plainJsonPrompting: boolean;
  systemMessages: boolean;
  separateSystemPrompt: boolean;
  usageMetadata: boolean;
  promptCaching: boolean;
  streaming: boolean;
  repairRetry: boolean;
  localTransport: boolean;
}

export interface ProviderContract {
  version: typeof PROVIDER_CONTRACT_VERSION;
  provider: string;
  protocol: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseURL: string;
  model: string;
  maxOutputTokens: number;
  capabilities: ProviderCapabilities;
  preferredRequestMode: ProviderRequestMode;
  fallbackRequestModes: ProviderRequestMode[];
  cost: ProviderCostClass;
  diagnostics: string[];
}

export interface ProviderContractInput {
  provider?: string;
  protocol?: ProviderProtocol;
  authMode?: ProviderAuthMode;
  baseURL?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export function inferProviderContract(input: ProviderContractInput = {}): ProviderContract {
  const protocol = input.protocol ?? inferProtocol(input.provider, input.baseURL);
  const provider = normalizeProviderName(input.provider ?? inferProviderName(input.baseURL, protocol));
  const baseURL = normalizeBaseURL(input.baseURL ?? defaultBaseURL(protocol));
  const model = input.model ?? defaultModel(protocol);
  const authMode = input.authMode ?? inferAuthMode(provider, baseURL);
  const localTransport = authMode === "none" || isLocalBaseURL(baseURL);
  const capabilities = inferCapabilities(protocol, provider, baseURL, localTransport);
  const modes = inferRequestModes(protocol, capabilities);

  return {
    version: PROVIDER_CONTRACT_VERSION,
    provider,
    protocol,
    authMode,
    baseURL,
    model,
    maxOutputTokens: normalizeMaxOutputTokens(input.maxTokens),
    capabilities,
    preferredRequestMode: modes[0] ?? "plain_json",
    fallbackRequestModes: modes.slice(1),
    cost: inferCost(provider, model, localTransport),
    diagnostics: inferDiagnostics(protocol, provider, baseURL, capabilities),
  };
}

export function providerRequiresApiKey(contract: ProviderContract): boolean {
  return contract.authMode !== "none";
}

export function buildOpenAICompatibleCompletionModes(
  contract: ProviderContract,
  nativeToolCount: number,
): Array<Extract<ProviderRequestMode, "native_tools" | "json_object" | "plain_json">> {
  const modes: Array<Extract<ProviderRequestMode, "native_tools" | "json_object" | "plain_json">> = [];
  if (contract.protocol !== "openai-compatible") return ["plain_json"];
  if (nativeToolCount > 0 && contract.capabilities.nativeToolCalling) modes.push("native_tools");
  if (contract.capabilities.jsonObjectMode) modes.push("json_object");
  if (contract.capabilities.plainJsonPrompting) modes.push("plain_json");
  return modes.length > 0 ? modes : ["plain_json"];
}

export function describeProviderContract(contract: ProviderContract): string {
  return [
    `provider=${contract.provider}`,
    `contract=${contract.version}`,
    `protocol=${contract.protocol}`,
    `auth=${contract.authMode}`,
    `model=${contract.model}`,
    `preferred=${contract.preferredRequestMode}`,
    `fallback=${contract.fallbackRequestModes.join(",") || "none"}`,
    `nativeTools=${contract.capabilities.nativeToolCalling}`,
    `jsonObject=${contract.capabilities.jsonObjectMode}`,
    `cost=${contract.cost}`,
  ].join("; ");
}

function inferProtocol(provider: string | undefined, baseURL: string | undefined): ProviderProtocol {
  const marker = `${provider ?? ""} ${baseURL ?? ""}`.toLowerCase();
  if (marker.includes("anthropic") || marker.includes("claude")) return "anthropic";
  if (marker.includes("gemini") || marker.includes("generativelanguage")) return "gemini";
  return "openai-compatible";
}

function inferProviderName(baseURL: string | undefined, protocol: ProviderProtocol): string {
  const value = (baseURL ?? "").toLowerCase();
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("siliconflow")) return "siliconflow";
  if (value.includes("ollama") || value.includes("127.0.0.1:11434")) return "ollama";
  if (value.includes("anthropic")) return "anthropic";
  if (value.includes("generativelanguage") || value.includes("gemini")) return "gemini";
  if (value.includes("openai")) return "openai";
  return protocol;
}

function normalizeProviderName(provider: string): string {
  const trimmed = provider.trim().toLowerCase();
  return trimmed || "openai-compatible";
}

function defaultBaseURL(protocol: ProviderProtocol): string {
  if (protocol === "anthropic") return DEFAULT_ANTHROPIC_BASE_URL;
  if (protocol === "gemini") return DEFAULT_GEMINI_BASE_URL;
  return DEFAULT_OPENAI_BASE_URL;
}

function defaultModel(protocol: ProviderProtocol): string {
  if (protocol === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  if (protocol === "gemini") return DEFAULT_GEMINI_MODEL;
  return DEFAULT_OPENAI_MODEL;
}

function inferAuthMode(provider: string, baseURL: string): ProviderAuthMode {
  return provider === "ollama" || isLocalBaseURL(baseURL) ? "none" : "api_key";
}

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLocalBaseURL(value: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(value);
}

function normalizeMaxOutputTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_OUTPUT_TOKENS;
}

function inferCapabilities(
  protocol: ProviderProtocol,
  provider: string,
  baseURL: string,
  localTransport: boolean,
): ProviderCapabilities {
  if (protocol === "anthropic") {
    return {
      nativeToolCalling: false,
      jsonObjectMode: false,
      plainJsonPrompting: true,
      systemMessages: true,
      separateSystemPrompt: true,
      usageMetadata: true,
      promptCaching: true,
      streaming: false,
      repairRetry: true,
      localTransport: false,
    };
  }

  if (protocol === "gemini") {
    return {
      nativeToolCalling: false,
      jsonObjectMode: true,
      plainJsonPrompting: true,
      systemMessages: true,
      separateSystemPrompt: true,
      usageMetadata: true,
      promptCaching: true,
      streaming: false,
      repairRetry: true,
      localTransport: false,
    };
  }

  const isOllama = provider === "ollama" || /ollama|127\.0\.0\.1:11434/i.test(baseURL);
  return {
    nativeToolCalling: !isOllama,
    jsonObjectMode: !isOllama,
    plainJsonPrompting: true,
    systemMessages: true,
    separateSystemPrompt: false,
    usageMetadata: true,
    promptCaching: !localTransport,
    streaming: false,
    repairRetry: true,
    localTransport,
  };
}

function inferRequestModes(protocol: ProviderProtocol, capabilities: ProviderCapabilities): ProviderRequestMode[] {
  if (protocol === "anthropic") return ["anthropic_messages"];
  if (protocol === "gemini") return ["gemini_json"];

  const modes: ProviderRequestMode[] = [];
  if (capabilities.nativeToolCalling) modes.push("native_tools");
  if (capabilities.jsonObjectMode) modes.push("json_object");
  if (capabilities.plainJsonPrompting) modes.push("plain_json");
  return modes;
}

function inferCost(provider: string, model: string, localTransport: boolean): ProviderCostClass {
  const marker = `${provider} ${model}`.toLowerCase();
  if (localTransport) return "local";
  if (/flash|mini|haiku|lite|small/.test(marker)) return "low";
  if (/pro|sonnet|opus|gpt-5|reasoner/.test(marker)) return "high";
  if (/deepseek|openrouter|siliconflow|gemini|claude|openai/.test(marker)) return "medium";
  return "unknown";
}

function inferDiagnostics(
  protocol: ProviderProtocol,
  provider: string,
  baseURL: string,
  capabilities: ProviderCapabilities,
): string[] {
  const diagnostics: string[] = [];
  if (provider === "ollama" || capabilities.localTransport) {
    diagnostics.push("Local OpenAI-compatible providers often work best with plain JSON fallback.");
  }
  if (protocol !== "openai-compatible") {
    diagnostics.push("Native tool calls are currently normalized through JSON action output for this provider.");
  }
  if (!capabilities.jsonObjectMode) {
    diagnostics.push("JSON object response mode is disabled; the runtime will rely on strict JSON prompting.");
  }
  if (!/^https?:\/\//i.test(baseURL)) {
    diagnostics.push("Base URL should include http:// or https://.");
  }
  return diagnostics;
}

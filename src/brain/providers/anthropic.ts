import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import {
  buildProviderMessages,
  buildProviderRepairMessages,
  parseProviderDecision,
  tryParseProviderDecision,
} from "./shared.js";
import { formatProviderEmptyResponse, formatProviderFetchError, formatProviderHttpError } from "./errors.js";
import { estimateMessagesTokens, mergeLlmTokenUsage, type LlmTokenUsage } from "../usage.js";
import { inferProviderContract, type ProviderContract } from "./contract.js";

export interface AnthropicModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  providerContract?: ProviderContract;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessagePart {
  type: "text";
  text: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicMessagePart[];
}

interface AnthropicRequest {
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  temperature: number;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface AnthropicResult {
  raw: string;
  usage?: LlmTokenUsage;
}

export class AnthropicModel implements LlmPlannerModel {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private providerContract: ProviderContract;

  constructor(config: AnthropicModelConfig = {}) {
    this.baseURL = (config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.SHIGUANG_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 2048;
    this.providerContract = config.providerContract ?? inferProviderContract({
      provider: "anthropic",
      protocol: "anthropic",
      authMode: this.apiKey ? "api_key" : undefined,
      baseURL: this.baseURL,
      model: this.model,
      maxTokens: this.maxTokens,
    });
  }

  async generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse> {
    const messages = buildProviderMessages(request);
    const first = await this.requestMessages(messages, context?.signal ?? request.signal);
    const parsed = tryParseProviderDecision(first.raw);
    if (parsed.ok) {
      return { ...parsed.response, usage: first.usage };
    }

    // Anthropic 没有直接复用 OpenAI 的 json_object 约束，所以这里同样保留一次 repair 重试。
    const repaired = await this.requestMessages(
      buildProviderRepairMessages(messages, first.raw),
      context?.signal ?? request.signal,
    );
    const mergedUsage = mergeLlmTokenUsage(first.usage, repaired.usage);
    const repairedParse = tryParseProviderDecision(repaired.raw);
    if (repairedParse.ok) {
      return {
        ...repairedParse.response,
        reasoning: `Model repair retry succeeded after parse error: ${parsed.error}`,
        usage: mergedUsage,
      };
    }

    return {
      ...parseProviderDecision(repaired.raw),
      usage: mergedUsage,
    };
  }

  private async requestMessages(providerMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<AnthropicResult> {
    // Anthropic 把 system 独立成顶层字段，非 system 消息再映射成 messages 数组。
    const system = providerMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages: AnthropicMessage[] = providerMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: [{ type: "text", text: message.content }],
      }));

    const body: AnthropicRequest = {
      model: this.model,
      ...(system ? { system } : {}),
      messages,
      max_tokens: this.maxTokens,
      temperature: 0.1,
    };

    const url = `${this.baseURL}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    }).catch((error: unknown) => {
      throw formatProviderFetchError("Anthropic", url, error);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw formatProviderHttpError("Anthropic", response.status, text);
    }

    const data = (await response.json()) as AnthropicResponse;
    const raw = data.content
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
    const usage = normalizeAnthropicUsage(data.usage, {
      provider: this.providerContract.provider,
      model: this.model,
      requestCount: 1,
      mode: this.providerContract.preferredRequestMode,
      promptEstimateTokens: estimateMessagesTokens(providerMessages),
    });
    if (!raw) {
      throw formatProviderEmptyResponse("Anthropic");
    }

    return { raw, usage };
  }
}

function normalizeAnthropicUsage(
  usage: AnthropicResponse["usage"] | undefined,
  base: LlmTokenUsage,
): LlmTokenUsage {
  const inputTokens = numberOrUndefined(usage?.input_tokens);
  const outputTokens = numberOrUndefined(usage?.output_tokens);
  const cachedInputTokens = numberOrUndefined(usage?.cache_read_input_tokens);
  const cacheCreationTokens = numberOrUndefined(usage?.cache_creation_input_tokens);

  return {
    ...base,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof inputTokens === "number" || typeof outputTokens === "number"
      ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
      : {}),
    ...(typeof cachedInputTokens === "number" || typeof cacheCreationTokens === "number"
      ? { cachedInputTokens: (cachedInputTokens ?? 0) + (cacheCreationTokens ?? 0) }
      : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

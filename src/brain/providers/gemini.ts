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

export interface GeminiModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  providerContract?: ProviderContract;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-pro";

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiRequest {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: "application/json";
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

interface GeminiResult {
  raw: string;
  usage?: LlmTokenUsage;
}

export class GeminiModel implements LlmPlannerModel {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private providerContract: ProviderContract;

  constructor(config: GeminiModelConfig = {}) {
    this.baseURL = (config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.SHIGUANG_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 2048;
    this.providerContract = config.providerContract ?? inferProviderContract({
      provider: "gemini",
      protocol: "gemini",
      authMode: this.apiKey ? "api_key" : undefined,
      baseURL: this.baseURL,
      model: this.model,
      maxTokens: this.maxTokens,
    });
  }

  async generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse> {
    const messages = buildProviderMessages(request);
    const first = await this.requestContent(messages, context?.signal ?? request.signal);
    const parsed = tryParseProviderDecision(first.raw);
    if (parsed.ok) {
      return { ...parsed.response, usage: first.usage };
    }

    // Gemini 侧也沿用“原请求 -> repair 请求”的双阶段策略，统一上层行为。
    const repaired = await this.requestContent(
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

  private async requestContent(providerMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<GeminiResult> {
    // Gemini 的 systemInstruction 与 contents 分离，因此这里先拆 system 再映射普通对话。
    const system = providerMessages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const contents: GeminiContent[] = providerMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      }));

    const body: GeminiRequest = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: this.maxTokens,
        // 要求直接给 application/json，尽量避免 prose/fence 污染。
        responseMimeType: "application/json",
      },
    };

    const url = new URL(`${this.baseURL}/models/${this.model}:generateContent`);
    url.searchParams.set("key", this.apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    }).catch((error: unknown) => {
      throw formatProviderFetchError("Gemini", url.toString(), error);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw formatProviderHttpError("Gemini", response.status, text);
    }

    const data = (await response.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim();
    const usage = normalizeGeminiUsage(data.usageMetadata, {
      provider: this.providerContract.provider,
      model: this.model,
      requestCount: 1,
      mode: this.providerContract.preferredRequestMode,
      promptEstimateTokens: estimateMessagesTokens(providerMessages),
    });
    if (!raw) {
      throw formatProviderEmptyResponse("Gemini");
    }

    return { raw, usage };
  }
}

function normalizeGeminiUsage(
  usage: GeminiResponse["usageMetadata"] | undefined,
  base: LlmTokenUsage,
): LlmTokenUsage {
  const inputTokens = numberOrUndefined(usage?.promptTokenCount);
  const outputTokens = numberOrUndefined(usage?.candidatesTokenCount);
  const totalTokens = numberOrUndefined(usage?.totalTokenCount)
    ?? (typeof inputTokens === "number" || typeof outputTokens === "number"
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  return {
    ...base,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
    ...(typeof usage?.cachedContentTokenCount === "number" ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
    ...(typeof usage?.thoughtsTokenCount === "number" ? { reasoningTokens: usage.thoughtsTokenCount } : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

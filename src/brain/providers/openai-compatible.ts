import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import type { ToolDescriptor } from "../../tools/types.js";
import { describeToolForNativeFunction } from "../../tools/protocol.js";
import {
  buildProviderMessages,
  buildProviderRepairMessages,
  parseProviderDecision,
  tryParseProviderDecision,
  type ProviderMessage,
} from "./shared.js";
import { formatProviderEmptyResponse, formatProviderFetchError, formatProviderHttpError } from "./errors.js";
import { estimateMessagesTokens, mergeLlmTokenUsage, type LlmTokenUsage } from "../usage.js";

export interface OpenAIModelConfig {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

interface OpenAIChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionMessage {
  content?: string | null;
  tool_calls?: ChatToolCall[];
}

interface ChatCompletionRequest {
  model: string;
  messages: ProviderMessage[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" };
  tools?: OpenAIChatTool[];
  tool_choice?: "auto";
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: ChatCompletionMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      audio_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
      accepted_prediction_tokens?: number;
      rejected_prediction_tokens?: number;
    };
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

type CompletionMode = "native_tools" | "json_object" | "plain_json";

interface CompletionResult {
  message: ChatCompletionMessage;
  usage?: LlmTokenUsage;
}

export class OpenAICompatibleModel implements LlmPlannerModel {
  private provider: string;
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: OpenAIModelConfig = {}) {
    this.provider = config.provider ?? inferProviderName(config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL);
    this.baseURL = (config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.SHIGUANG_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 2048;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse> {
    const messages = buildProviderMessages(request);
    const nativeTools = buildNativeTools(request.availableTools);
    const signal = context?.signal ?? request.signal;
    const promptEstimateTokens = estimateMessagesTokens(messages, JSON.stringify(nativeTools));
    const toolSchemaStats = {
      selectedToolSchemaCount: request.availableTools.length,
      totalToolSchemaCount: request.totalAvailableToolCount ?? request.availableTools.length,
    };

    const first = await this.requestCompletion(messages, signal, nativeTools, undefined, {
      promptEstimateTokens,
      ...toolSchemaStats,
    });
    const nativeDecision = parseNativeToolCall(first.message);
    if (nativeDecision) {
      return { ...nativeDecision, usage: first.usage };
    }

    const raw = normalizeMessageContent(first.message);
    const parsed = tryParseProviderDecision(raw);
    if (parsed.ok) {
      return { ...parsed.response, usage: first.usage };
    }

    const repairMessages = buildProviderRepairMessages(messages, raw || stringifyMessageForRepair(first.message));
    const repairResult = await this.requestCompletion(
      repairMessages,
      signal,
      nativeTools,
      undefined,
      {
        promptEstimateTokens: estimateMessagesTokens(repairMessages, JSON.stringify(nativeTools)),
        ...toolSchemaStats,
      },
    );
    const mergedUsage = mergeLlmTokenUsage(first.usage, repairResult.usage);
    const repairedNativeDecision = parseNativeToolCall(repairResult.message);
    if (repairedNativeDecision) {
      return {
        ...repairedNativeDecision,
        reasoning: `Model repair retry returned native tool call after parse error: ${parsed.error}`,
        usage: mergedUsage,
      };
    }

    const repairedRaw = normalizeMessageContent(repairResult.message);
    const repairedParse = tryParseProviderDecision(repairedRaw);
    if (repairedParse.ok) {
      return {
        ...repairedParse.response,
        reasoning: `Model repair retry succeeded after parse error: ${parsed.error}`,
        usage: mergedUsage,
      };
    }

    return {
      ...parseProviderDecision(repairedRaw || stringifyMessageForRepair(repairResult.message)),
      usage: mergedUsage,
    };
  }

  private async requestCompletion(
    messages: ProviderMessage[],
    signal?: AbortSignal,
    nativeTools: OpenAIChatTool[] = [],
    mode?: CompletionMode,
    usageHints?: Partial<LlmTokenUsage>,
  ): Promise<CompletionResult> {
    const completionMode = mode ?? (nativeTools.length > 0 ? "native_tools" : "json_object");
    const useNativeTools = completionMode === "native_tools" && nativeTools.length > 0;
    const body: ChatCompletionRequest = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: 0.1,
      ...(useNativeTools
        ? { tools: nativeTools, tool_choice: "auto" as const }
        : completionMode === "json_object"
          ? { response_format: { type: "json_object" as const } }
          : {}),
    };

    const url = `${this.baseURL}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    }).catch((error: unknown) => {
      throw formatProviderFetchError("OpenAI-compatible", url, error);
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      if (useNativeTools && isNativeToolUnsupported(response.status, text)) {
        return this.requestCompletion(messages, signal, [], "json_object", usageHints);
      }
      if (completionMode === "json_object" && isJsonModeUnsupported(response.status, text)) {
        return this.requestCompletion(messages, signal, [], "plain_json", usageHints);
      }
      throw formatProviderHttpError("OpenAI-compatible", response.status, text);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const usage = normalizeOpenAIUsage(data.usage, {
      provider: this.provider,
      model: this.model,
      mode: completionMode,
      ...usageHints,
    });
    const message = data.choices?.[0]?.message;
    if (!message) {
      const fallback = nextFallbackMode(completionMode);
      if (fallback) {
        const fallbackResult = await this.requestCompletion(messages, signal, [], fallback, usageHints);
        return { ...fallbackResult, usage: mergeLlmTokenUsage(usage, fallbackResult.usage) };
      }
      throw formatProviderEmptyResponse("OpenAI-compatible");
    }
    if (!normalizeMessageContent(message) && !hasToolCalls(message)) {
      const fallback = nextFallbackMode(completionMode);
      if (fallback) {
        const fallbackResult = await this.requestCompletion(messages, signal, [], fallback, usageHints);
        return { ...fallbackResult, usage: mergeLlmTokenUsage(usage, fallbackResult.usage) };
      }
      throw formatProviderEmptyResponse("OpenAI-compatible");
    }

    return { message, usage };
  }
}

function inferProviderName(baseURL: string | undefined): string {
  const value = (baseURL ?? DEFAULT_BASE_URL).toLowerCase();
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("siliconflow")) return "siliconflow";
  if (value.includes("ollama") || value.includes("127.0.0.1:11434")) return "ollama";
  if (value.includes("openai")) return "openai";
  return "openai-compatible";
}

function normalizeOpenAIUsage(
  usage: ChatCompletionResponse["usage"] | undefined,
  base: Omit<LlmTokenUsage, "requestCount">,
): LlmTokenUsage {
  const inputTokens = numberOrUndefined(usage?.prompt_tokens);
  const outputTokens = numberOrUndefined(usage?.completion_tokens);
  const totalTokens = numberOrUndefined(usage?.total_tokens)
    ?? (typeof inputTokens === "number" || typeof outputTokens === "number"
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const cachedInputTokens = numberOrUndefined(usage?.prompt_tokens_details?.cached_tokens)
    ?? numberOrUndefined(usage?.prompt_cache_hit_tokens);
  const reasoningTokens = numberOrUndefined(usage?.completion_tokens_details?.reasoning_tokens);

  return {
    ...base,
    requestCount: 1,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildNativeTools(tools: ToolDescriptor[]): OpenAIChatTool[] {
  return tools
    .filter((tool) => isValidOpenAIToolName(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: buildToolDescription(tool),
        parameters: normalizeToolParameters(tool.inputSchema),
      },
    }));
}

function buildToolDescription(tool: ToolDescriptor): string {
  return describeToolForNativeFunction(tool);
}

function normalizeToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return emptyObjectSchema();
  }

  if (schema.type === "object" || !("type" in schema)) {
    return schema;
  }

  return emptyObjectSchema();
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function isValidOpenAIToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function parseNativeToolCall(message: ChatCompletionMessage): LlmPlannerModelResponse | null {
  const call = message.tool_calls?.find((candidate) => {
    if (candidate.type && candidate.type !== "function") return false;
    return typeof candidate.function?.name === "string" && candidate.function.name.length > 0;
  });
  if (!call?.function?.name) {
    return null;
  }

  return {
    reasoning: `Model requested native tool call ${call.function.name}${call.id ? ` (${call.id})` : ""}`,
    action: {
      kind: "tool_call",
      toolName: call.function.name,
      toolInput: parseToolArguments(call.function.arguments),
    },
  };
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeMessageContent(message: ChatCompletionMessage): string {
  return typeof message.content === "string" ? message.content.trim() : "";
}

function hasToolCalls(message: ChatCompletionMessage): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function stringifyMessageForRepair(message: ChatCompletionMessage): string {
  return JSON.stringify(message).slice(0, 4000);
}

function isNativeToolUnsupported(status: number, message: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /\b(tools?|tool_choice|functions?|function_call)\b/i.test(message);
}

function isJsonModeUnsupported(status: number, message: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /\b(response_format|json_object|json mode)\b/i.test(message);
}

function nextFallbackMode(mode: CompletionMode): CompletionMode | null {
  if (mode === "native_tools") return "json_object";
  if (mode === "json_object") return "plain_json";
  return null;
}

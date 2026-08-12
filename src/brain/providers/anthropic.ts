import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import {
  buildProviderMessages,
  buildProviderRepairMessages,
  parseProviderDecision,
  tryParseProviderDecision,
} from "./shared.js";
import { formatProviderEmptyResponse, formatProviderFetchError, formatProviderHttpError } from "./errors.js";

export interface AnthropicModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
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
}

export class AnthropicModel implements LlmPlannerModel {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: AnthropicModelConfig = {}) {
    this.baseURL = (config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.SHIGUANG_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 2048;
  }

  async generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse> {
    const messages = buildProviderMessages(request);
    const raw = await this.requestMessages(messages, context?.signal ?? request.signal);
    const parsed = tryParseProviderDecision(raw);
    if (parsed.ok) {
      return parsed.response;
    }

    // Anthropic 没有直接复用 OpenAI 的 json_object 约束，所以这里同样保留一次 repair 重试。
    const repairedRaw = await this.requestMessages(
      buildProviderRepairMessages(messages, raw),
      context?.signal ?? request.signal,
    );
    const repaired = tryParseProviderDecision(repairedRaw);
    if (repaired.ok) {
      return {
        ...repaired.response,
        reasoning: `Model repair retry succeeded after parse error: ${parsed.error}`,
      };
    }

    return parseProviderDecision(repairedRaw);
  }

  private async requestMessages(providerMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<string> {
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
    if (!raw) {
      throw formatProviderEmptyResponse("Anthropic");
    }

    return raw;
  }
}

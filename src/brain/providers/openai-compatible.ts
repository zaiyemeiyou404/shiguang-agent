import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import {
  buildProviderMessages,
  buildProviderRepairMessages,
  parseProviderDecision,
  tryParseProviderDecision,
  type ProviderMessage,
} from "./shared.js";

export interface OpenAIModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

interface ChatCompletionRequest {
  model: string;
  messages: ProviderMessage[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

export class OpenAICompatibleModel implements LlmPlannerModel {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: OpenAIModelConfig = {}) {
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
    const raw = await this.requestCompletion(messages, context?.signal ?? request.signal);
    const parsed = tryParseProviderDecision(raw);
    if (parsed.ok) {
      return parsed.response;
    }

    // 第一次输出 parse 失败时，不立刻 fail，而是发一次“只修 JSON 格式”的补救请求。
    const repairedRaw = await this.requestCompletion(
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

  private async requestCompletion(messages: ProviderMessage[], signal?: AbortSignal): Promise<string> {
    const body: ChatCompletionRequest = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: 0.1,
      // 能声明 JSON 模式的 provider，尽量在 API 层先约束输出形态。
      response_format: { type: "json_object" },
    };

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error("OpenAI returned empty response");
    }

    return raw;
  }
}

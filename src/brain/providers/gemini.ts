import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import {
  buildProviderMessages,
  buildProviderRepairMessages,
  parseProviderDecision,
  tryParseProviderDecision,
} from "./shared.js";
import { fetchWithNetworkProxy } from "./network.js";

export interface GeminiModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
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
}

export class GeminiModel implements LlmPlannerModel {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;

  constructor(config: GeminiModelConfig = {}) {
    this.baseURL = (config.baseURL ?? process.env.SHIGUANG_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "";
    this.model = config.model ?? process.env.SHIGUANG_LLM_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 2048;
  }

  async generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse> {
    const messages = buildProviderMessages(request);
    const raw = await this.requestContent(messages, context?.signal ?? request.signal);
    const parsed = tryParseProviderDecision(raw);
    if (parsed.ok) {
      return parsed.response;
    }

    // Gemini 侧也沿用“原请求 -> repair 请求”的双阶段策略，统一上层行为。
    const repairedRaw = await this.requestContent(
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

  private async requestContent(providerMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<string> {
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

    const response = await fetchWithNetworkProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`Gemini API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim();
    if (!raw) {
      throw new Error("Gemini returned empty response");
    }

    return raw;
  }
}

import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse, PlannerContext } from "../model-types.js";
import type { ToolDescriptor } from "../../tools/types.js";
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
}

type CompletionMode = "native_tools" | "json_object" | "plain_json";

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
    const nativeTools = buildNativeTools(request.availableTools);
    const signal = context?.signal ?? request.signal;

    const firstMessage = await this.requestCompletion(messages, signal, nativeTools);
    const nativeDecision = parseNativeToolCall(firstMessage);
    if (nativeDecision) {
      return nativeDecision;
    }

    const raw = normalizeMessageContent(firstMessage);
    const parsed = tryParseProviderDecision(raw);
    if (parsed.ok) {
      return parsed.response;
    }

    const repairedMessage = await this.requestCompletion(
      buildProviderRepairMessages(messages, raw || stringifyMessageForRepair(firstMessage)),
      signal,
      nativeTools,
    );
    const repairedNativeDecision = parseNativeToolCall(repairedMessage);
    if (repairedNativeDecision) {
      return {
        ...repairedNativeDecision,
        reasoning: `Model repair retry returned native tool call after parse error: ${parsed.error}`,
      };
    }

    const repairedRaw = normalizeMessageContent(repairedMessage);
    const repaired = tryParseProviderDecision(repairedRaw);
    if (repaired.ok) {
      return {
        ...repaired.response,
        reasoning: `Model repair retry succeeded after parse error: ${parsed.error}`,
      };
    }

    return parseProviderDecision(repairedRaw || stringifyMessageForRepair(repairedMessage));
  }

  private async requestCompletion(
    messages: ProviderMessage[],
    signal?: AbortSignal,
    nativeTools: OpenAIChatTool[] = [],
    mode?: CompletionMode,
  ): Promise<ChatCompletionMessage> {
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
      if (useNativeTools && isNativeToolUnsupported(response.status, text)) {
        return this.requestCompletion(messages, signal, [], "json_object");
      }
      if (completionMode === "json_object" && isJsonModeUnsupported(response.status, text)) {
        return this.requestCompletion(messages, signal, [], "plain_json");
      }
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      const fallback = nextFallbackMode(completionMode);
      if (fallback) {
        return this.requestCompletion(messages, signal, [], fallback);
      }
      throw new Error("OpenAI returned no message after native/json/plain fallbacks");
    }
    if (!normalizeMessageContent(message) && !hasToolCalls(message)) {
      const fallback = nextFallbackMode(completionMode);
      if (fallback) {
        return this.requestCompletion(messages, signal, [], fallback);
      }
      throw new Error("OpenAI returned empty response after native/json/plain fallbacks");
    }

    return message;
  }
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
  const effects = tool.effects
    ? ` Effects: workspaceMutation=${tool.effects.workspaceMutation === true}, validationMode=${tool.effects.validationMode ?? "none"}.`
    : "";
  const approval = tool.requiresApproval ? " Requires approval before execution." : "";
  return `${tool.description}${effects}${approval}`.trim().slice(0, 1024);
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

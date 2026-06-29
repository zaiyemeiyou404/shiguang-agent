import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse } from "./planner.js";
import type { BrainAction } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface OpenAIModelConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
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

function buildSystemPrompt(tools: ToolDescriptor[]): string {
  const toolLines = tools.map(
    (t) => `- ${t.name}: ${t.description} (input schema: ${JSON.stringify(t.inputSchema)})`,
  ).join("\n");

  return [
    "You are a helpful AI agent. You can use the following tools:",
    "",
    toolLines,
    "",
    "You MUST respond with STRICT JSON only, using one of these formats:",
    "",
    'To respond to the user: { "kind": "respond", "content": "your message here" }',
    "",
    'To call a tool: { "kind": "tool_call", "toolName": "tool_name", "toolInput": <input as required by tool> }',
    "",
    'To finish: { "kind": "finish", "content": "summary of what was done" }',
    "",
    'To indicate failure: { "kind": "fail", "reason": "explanation" }',
    "",
    "Do NOT include markdown code fences or any text outside the JSON object.",
    "Return ONLY the JSON object, nothing else.",
  ].join("\n");
}

type ParseResult =
  | { ok: true; action: BrainAction }
  | { ok: false; error: string };

function tryParseAction(raw: string): ParseResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: `Failed to parse JSON: ${cleaned.slice(0, 200)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Parsed value is not an object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.kind === "respond") {
    if (typeof obj.content !== "string") {
      return { ok: false, error: "respond action missing string content" };
    }
    return { ok: true, action: { kind: "respond", content: obj.content } };
  }

  if (obj.kind === "tool_call") {
    if (typeof obj.toolName !== "string") {
      return { ok: false, error: "tool_call action missing string toolName" };
    }
    return { ok: true, action: { kind: "tool_call", toolName: obj.toolName, toolInput: obj.toolInput } };
  }

  if (obj.kind === "finish") {
    return { ok: true, action: { kind: "finish", content: typeof obj.content === "string" ? obj.content : "Done." } };
  }

  if (obj.kind === "fail") {
    return { ok: true, action: { kind: "fail", reason: typeof obj.reason === "string" ? obj.reason : "Unknown failure" } };
  }

  return { ok: false, error: `Unknown action kind: ${JSON.stringify(obj.kind)}` };
}

export class OpenAIModel implements LlmPlannerModel {
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

  async generateDecision(request: LlmPlannerModelRequest): Promise<LlmPlannerModelResponse> {
    const messages: ChatMessage[] = [];

    const systemPrompt = buildSystemPrompt(request.availableTools);
    messages.push({ role: "system", content: systemPrompt });

    for (const msg of request.messages) {
      messages.push(msg as ChatMessage);
    }

    if (request.history.length > 0) {
      const lastFew = request.history.slice(-5);
      for (const h of lastFew) {
        if (h.action.kind === "respond") {
          messages.push({ role: "assistant", content: JSON.stringify({ kind: "respond", content: h.action.content }) });
        } else if (h.action.kind === "tool_call") {
          messages.push({ role: "assistant", content: JSON.stringify({ kind: "tool_call", toolName: h.action.toolName, toolInput: h.action.toolInput }) });
          const out = typeof h.output === "string" ? h.output : JSON.stringify(h.output);
          messages.push({ role: "user", content: `Tool result for ${h.action.toolName}: ${out}` });
        } else if (h.action.kind === "finish") {
          messages.push({ role: "assistant", content: `Finishing: ${h.action.content ?? "Done."}` });
        }
      }
    }

    const body: ChatCompletionRequest = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
    };

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
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

    const result = tryParseAction(raw);
    if (!result.ok) {
      return {
        reasoning: `Parse error: ${result.error}`,
        action: { kind: "fail", reason: `Failed to parse model response: ${result.error}` },
      };
    }

    return { action: result.action, reasoning: `Model responded with ${result.action.kind}` };
  }
}

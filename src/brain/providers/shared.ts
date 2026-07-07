import type { LlmPlannerModelRequest, LlmPlannerModelResponse } from "../model-types.js";
import { tryParseAction } from "../action-parser.js";
import {
  buildSystemPrompt,
  formatHistory,
  formatValidationRepairGuidance,
  formatWorkingMemory,
} from "../prompt-builder.js";

const REPAIR_INSTRUCTION = [
  "你上一条回复不符合 agent 运行时要求。",
  "请只返回一个合法的 JSON 对象，不要输出别的内容。",
  "不要使用 markdown 代码块。",
  '允许的格式：{"kind":"respond","content":"..."}、{"kind":"finish","content":"..."}、{"kind":"fail","reason":"..."}、{"kind":"tool_call","toolName":"...","toolInput":...}、{"kind":"needs_approval","toolName":"...","toolInput":...,"reason":"..."}。',
].join(" ");

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderDecisionParseResult =
  | { ok: true; response: LlmPlannerModelResponse }
  | { ok: false; error: string };

export function buildProviderMessages(request: LlmPlannerModelRequest): ProviderMessage[] {
  const messages: ProviderMessage[] = [];

  // 统一先拼 system，再附 workingMemory / repair guidance / user+assistant history，方便不同 provider 共享同一语义。
  const systemPrompt = [
    buildSystemPrompt(request.availableTools),
    request.systemPrompt ? `Context instructions:\n${request.systemPrompt}` : "",
  ].filter(Boolean).join("\n\n");
  messages.push({ role: "system", content: systemPrompt });

  if (request.workingMemory) {
    messages.push({ role: "system", content: formatWorkingMemory(request.workingMemory) });
  }

  const validationRepairGuidance = formatValidationRepairGuidance(request.workingMemory);
  if (validationRepairGuidance) {
    messages.push({ role: "system", content: validationRepairGuidance });
  }

  for (const message of request.messages) {
    messages.push(message);
  }

  if (request.history.length > 0) {
    messages.push({ role: "system", content: formatHistory(request.history) });
  }

  return messages;
}

export function buildProviderRepairMessages(messages: ProviderMessage[], invalidRaw: string): ProviderMessage[] {
  return [
    ...messages,
    { role: "assistant", content: invalidRaw.slice(0, 4000) },
    {
      role: "user",
      // repair 消息把“错误原文”回灌给模型，要求它只修格式，不改变动作语义。
      content: `${REPAIR_INSTRUCTION}\n\nInvalid previous reply:\n${invalidRaw.slice(0, 4000)}`,
    },
  ];
}

export function tryParseProviderDecision(raw: string): ProviderDecisionParseResult {
  // parser 尽量把 provider 的“近似 JSON”修回合法 action，减少一次 bad format 就整轮失败。
  const result = tryParseAction(raw);
  if (!result.ok) {
    return {
      ok: false,
      error: "error" in result ? result.error : "Unknown parse error",
    };
  }

  return {
    ok: true,
    response: {
      action: result.action,
      reasoning: `Model responded with ${result.action.kind}`,
    },
  };
}

export function parseProviderDecision(raw: string): LlmPlannerModelResponse {
  const result = tryParseProviderDecision(raw);
  if (result.ok) {
    return result.response;
  }

  return {
    reasoning: `Parse error: ${result.error}`,
    action: { kind: "fail", reason: `Failed to parse model response: ${result.error}` },
  };
}

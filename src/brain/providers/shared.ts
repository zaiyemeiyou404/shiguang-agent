import type { LlmPlannerModelRequest, LlmPlannerModelResponse } from "../model-types.js";
import { tryParseAction } from "../action-parser.js";
import {
  buildSystemPrompt,
  formatHistory,
  formatValidationRepairGuidance,
  formatWorkingMemory,
} from "../prompt-builder.js";

const REPAIR_INSTRUCTION = [
  "Your previous reply did not match the agent runtime contract.",
  "Return exactly one valid JSON object and no other text.",
  "Do not use markdown code fences.",
  'Allowed shapes: {"kind":"respond","content":"..."}, {"kind":"finish","content":"..."}, {"kind":"fail","reason":"..."}, {"kind":"tool_call","toolName":"...","toolInput":...}.',
  "Do not emit needs_approval; runtime policy handles approval.",
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
      content: `${REPAIR_INSTRUCTION}\n\nInvalid previous reply:\n${invalidRaw.slice(0, 4000)}`,
    },
  ];
}

export function tryParseProviderDecision(raw: string): ProviderDecisionParseResult {
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

import type { BrainDecision, ActionResult, WorkingMemorySnapshot } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";
import type { LlmTokenUsage } from "./usage.js";

export interface PlannerContext {
  signal?: AbortSignal;
}

export interface LlmPlannerModelRequest {
  signal?: AbortSignal;
  systemPrompt?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  availableTools: ToolDescriptor[];
  totalAvailableToolCount?: number;
  history: ActionResult[];
  workingMemory?: WorkingMemorySnapshot;
}

export interface LlmPlannerModelResponse {
  reasoning?: string;
  action: BrainDecision["action"];
  usage?: LlmTokenUsage;
}

export interface LlmPlannerModel {
  generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse>;
}

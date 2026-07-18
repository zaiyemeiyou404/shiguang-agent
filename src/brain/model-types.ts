import type { BrainDecision, ActionResult, WorkingMemorySnapshot } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface PlannerContext {
  signal?: AbortSignal;
}

export interface LlmPlannerModelRequest {
  signal?: AbortSignal;
  systemPrompt?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  availableTools: ToolDescriptor[];
  history: ActionResult[];
  workingMemory?: WorkingMemorySnapshot;
}

export interface LlmPlannerModelResponse {
  reasoning?: string;
  action: BrainDecision["action"];
}

export interface LlmPlannerModel {
  generateDecision(request: LlmPlannerModelRequest, context?: PlannerContext): Promise<LlmPlannerModelResponse>;
}

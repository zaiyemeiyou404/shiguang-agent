import type { BrainInput, BrainDecision, ActionResult, WorkingMemorySnapshot } from "./types.js";
import type { ToolDescriptor, ValidationModeHint } from "../tools/types.js";
import { renderPrompt, type RenderedPrompt } from "../context/render.js";

export interface Planner {
  decide(input: BrainInput): Promise<BrainDecision>;
}

export interface LlmPlannerModelRequest {
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
  generateDecision(request: LlmPlannerModelRequest): Promise<LlmPlannerModelResponse>;
}

export class LlmPlanner implements Planner {
  constructor(private model: LlmPlannerModel) {}

  async decide(input: BrainInput): Promise<BrainDecision> {
    const lastResult = input.history.length > 0 ? input.history[input.history.length - 1] ?? null : null;
    const automaticValidationMode = inferAutomaticValidationMode(lastResult, input.availableTools);
    if (automaticValidationMode) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: automaticValidationMode } },
        reasoning: `Successful workspace mutation detected; running validation mode: ${automaticValidationMode}`,
      };
    }

    const request = this.buildRequest(input);
    const response = await this.model.generateDecision(request);
    return { action: response.action, reasoning: response.reasoning };
  }

  private buildRequest(input: BrainInput): LlmPlannerModelRequest {
    const prompt: RenderedPrompt = renderPrompt(input.context, input.priorTurns);

    return {
      systemPrompt: prompt.system || undefined,
      messages: prompt.messages,
      availableTools: input.availableTools,
      history: input.history,
      workingMemory: input.workingMemory,
    };
  }
}

export class RulePlanner implements Planner {
  async decide(input: BrainInput): Promise<BrainDecision> {
    const prompt: RenderedPrompt = renderPrompt(input.context, input.priorTurns);
    const userItem = input.context.volatile.find(i => i.kind === "user_turn");
    const msg = userItem?.content ?? prompt.messages.find(m => m.role === "user")?.content ?? "";

    if (!msg) {
      return {
        action: { kind: "respond", content: "No user input found." },
        reasoning: "Context did not include a user turn.",
      };
    }

    const echoPrefix = "use echo";

    const lastResult = input.history.length > 0
      ? input.history[input.history.length - 1]
      : null;

    if (input.history.length === 0 && msg.toLowerCase().startsWith(echoPrefix)) {
      const rest = msg.slice(echoPrefix.length).trim();
      return {
        action: { kind: "tool_call", toolName: "echo", toolInput: rest || msg },
        reasoning: `User requested echo tool with: ${rest || msg}`,
      };
    }

    const validationMode = input.history.length === 0 ? inferValidationMode(msg) : null;
    if (validationMode && input.availableTools.some((tool) => tool.name === "run_validation")) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: validationMode } },
        reasoning: `User requested validation mode: ${validationMode}`,
      };
    }

    const automaticValidationMode = inferAutomaticValidationMode(lastResult ?? null, input.availableTools);
    if (automaticValidationMode) {
      return {
        action: { kind: "tool_call", toolName: "run_validation", toolInput: { mode: automaticValidationMode } },
        reasoning: `Successful workspace mutation detected; running validation mode: ${automaticValidationMode}`,
      };
    }

    if (lastResult && lastResult.action.kind === "tool_call" && lastResult.ok) {
      return {
        action: {
          kind: "finish",
          content: `Tool output: ${JSON.stringify(lastResult.output)}`,
        },
        reasoning: "Previous tool call succeeded, finishing with summary of output.",
      };
    }

    if (lastResult && lastResult.action.kind === "respond") {
      return {
        action: {
          kind: "finish",
          content: `Previous response was: "${lastResult.output}". Done.`,
        },
        reasoning: "Already responded, finishing.",
      };
    }

    return {
      action: {
        kind: "respond",
        content: `I received your message: "${msg}". How can I help further?`,
      },
      reasoning: "No tool requested, providing a simple response.",
    };
  }
}

function inferValidationMode(message: string): "typecheck" | "test" | "build" | "all" | null {
  const text = message.toLowerCase();

  if (text.includes("typecheck")) return "typecheck";
  if (text.includes("run tests") || /\btests?\b/.test(text)) return "test";
  if (/\bbuild\b/.test(text)) return "build";
  if (text.includes("validate") || text.includes("validation")) return "all";

  return null;
}

function inferAutomaticValidationMode(
  lastResult: ActionResult | null,
  availableTools: ToolDescriptor[],
): ValidationModeHint | null {
  if (!lastResult || !lastResult.ok) return null;
  if (lastResult.action.kind !== "tool_call") return null;
  if (!availableTools.some((tool) => tool.name === "run_validation")) return null;
  if (lastResult.metadata?.category !== "tool_observation") return null;
  if (lastResult.metadata.toolName === "run_validation") return null;
  if (lastResult.metadata.workspaceMutation !== true) return null;

  return lastResult.metadata.validationMode ?? "all";
}

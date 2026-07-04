import type { BrainInput, BrainDecision, ActionResult } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface Planner {
  decide(input: BrainInput): Promise<BrainDecision>;
}

export interface LlmPlannerModelRequest {
  systemPrompt?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  availableTools: ToolDescriptor[];
  history: ActionResult[];
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
    const request = this.buildRequest(input);
    const response = await this.model.generateDecision(request);
    return { action: response.action, reasoning: response.reasoning };
  }

  private buildRequest(input: BrainInput): LlmPlannerModelRequest {
    const messages: LlmPlannerModelRequest["messages"] = [];
    let systemPrompt: string | undefined;

    for (const item of input.context.items) {
      if (item.kind === "system_instruction") {
        messages.push({ role: "system", content: item.content });
      } else if (item.kind === "user_turn") {
        messages.push({ role: "user", content: item.content });
      }
    }

    const sysItems = input.context.items.filter((i) => i.kind === "system_instruction");
    if (sysItems.length > 0) {
      systemPrompt = sysItems.map((i) => i.content).join("\n");
    }

    return { systemPrompt, messages, availableTools: input.availableTools, history: input.history };
  }
}

export class RulePlanner implements Planner {
  async decide(input: BrainInput): Promise<BrainDecision> {
    const items = input.context.items;
    const userItem = items.find((i) => i.kind === "user_turn");

    if (!userItem) {
      return {
        action: { kind: "respond", content: "No user input found." },
      };
    }

    const msg = userItem.content;
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

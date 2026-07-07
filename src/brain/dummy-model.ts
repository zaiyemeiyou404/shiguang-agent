import type { LlmPlannerModel, LlmPlannerModelRequest, LlmPlannerModelResponse } from "./model-types.js";

export class EchoDecisionModel implements LlmPlannerModel {
  async generateDecision(request: LlmPlannerModelRequest): Promise<LlmPlannerModelResponse> {
    const lastResult = request.history.at(-1);

    if (lastResult?.action.kind === "tool_call" && lastResult.ok) {
      const out = typeof lastResult.output === "string" ? lastResult.output : JSON.stringify(lastResult.output);
      return {
        reasoning: "EchoDecisionModel: tool succeeded, finishing.",
        action: { kind: "finish", content: `Tool returned: ${out}` },
      };
    }

    if (lastResult?.action.kind === "respond") {
      return {
        reasoning: "EchoDecisionModel: already responded, finishing.",
        action: { kind: "finish", content: lastResult.action.content ?? "Done." },
      };
    }

    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
    const text = lastUserMsg?.content ?? "";

    if (text.toLowerCase().startsWith("use echo")) {
      const rest = text.slice("use echo".length).trim();
      return {
        reasoning: `EchoDecisionModel: user requested echo with "${rest}"`,
        action: { kind: "tool_call", toolName: "echo", toolInput: rest || text },
      };
    }

    return {
      reasoning: "EchoDecisionModel: no special command, responding generically.",
      action: { kind: "respond", content: `I heard: "${text}". (EchoDecisionModel stub)` },
    };
  }
}

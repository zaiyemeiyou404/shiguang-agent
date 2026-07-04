import type { Planner } from "../dist/brain/planner.js";
import { RulePlanner } from "../dist/brain/planner.js";
import { LlmPlanner } from "../dist/brain/planner.js";
import { OpenAIModel } from "../dist/brain/openai-model.js";
import type { ResolvedLlmConfig } from "./config.js";

export interface PlannerFactoryResult {
  planner: Planner;
  label: string;
}

export function createPlanner(config?: ResolvedLlmConfig): PlannerFactoryResult {
  const apiKey = config?.apiKey ?? process.env.SHIGUANG_LLM_API_KEY;

  if (apiKey) {
    const model = new OpenAIModel({
      apiKey,
      baseURL: config?.baseURL,
      model: config?.model,
      maxTokens: config?.maxTokens,
    });
    const planner = new LlmPlanner(model);
    const providerLabel = config?.provider ? `:${config.provider}` : "";
    return { planner, label: `llm${providerLabel}` };
  }

  return { planner: new RulePlanner(), label: "rule" };
}

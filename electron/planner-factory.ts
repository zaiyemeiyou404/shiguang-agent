import type { Planner } from "../dist/brain/planner.js";
import { RulePlanner } from "../dist/brain/planner.js";
import { LlmPlanner } from "../dist/brain/planner.js";
import { OpenAIModel } from "../dist/brain/openai-model.js";

export interface PlannerFactoryResult {
  planner: Planner;
  label: string;
}

export function createPlanner(): PlannerFactoryResult {
  const apiKey = process.env.SHIGUANG_LLM_API_KEY;

  if (apiKey) {
    const model = new OpenAIModel();
    const planner = new LlmPlanner(model);
    return { planner, label: "llm" };
  }

  return { planner: new RulePlanner(), label: "rule" };
}

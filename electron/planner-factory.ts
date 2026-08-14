import type { Planner } from "../dist/brain/planner.js";
import { RulePlanner } from "../dist/brain/planner.js";
import { LlmPlanner } from "../dist/brain/planner.js";
import type { LlmPlannerModel, LlmPlannerModelResponse } from "../dist/brain/model-types.js";
import { AnthropicModel } from "../dist/brain/providers/anthropic.js";
import { GeminiModel } from "../dist/brain/providers/gemini.js";
import { OpenAICompatibleModel } from "../dist/brain/providers/openai-compatible.js";
import {
  inferProviderContract,
  providerRequiresApiKey,
  type ProviderContract,
} from "../dist/brain/providers/contract.js";
import type { ProviderProtocol, ResolvedLlmConfig } from "./config.js";

export interface PlannerFactoryResult {
  planner: Planner;
  label: string;
}

interface ModelFactoryResult {
  model?: LlmPlannerModel;
  label: string;
  errorReason?: string;
  providerContract?: ProviderContract;
}

type ProviderModelFactory = (config: ResolvedLlmConfig, contract: ProviderContract) => ModelFactoryResult;

const providerFactories: Record<ProviderProtocol, ProviderModelFactory> = {
  "openai-compatible": createOpenAICompatibleProvider,
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
};

class StaticFailureModel implements LlmPlannerModel {
  constructor(private readonly reason: string) {}

  async generateDecision(): Promise<LlmPlannerModelResponse> {
    return {
      reasoning: this.reason,
      action: { kind: "fail", reason: this.reason },
    };
  }
}

export function createPlanner(config?: ResolvedLlmConfig): PlannerFactoryResult {
  if (!config) {
    return { planner: new RulePlanner(), label: "rule" };
  }

  const provider = createModelProvider(config);
  if (!provider.model) {
    return {
      planner: new LlmPlanner(new StaticFailureModel(provider.errorReason ?? `Provider ${config.provider} is not available.`)),
      label: provider.label,
    };
  }

  return {
    planner: new LlmPlanner(provider.model),
    label: provider.label,
  };
}

export function createModelProvider(config: ResolvedLlmConfig): ModelFactoryResult {
  const factory = providerFactories[config.providerType];
  const contract = inferProviderContract({
    provider: config.provider,
    protocol: config.providerType,
    authMode: config.authMode,
    baseURL: config.baseURL,
    model: config.model,
    maxTokens: config.maxTokens,
  });
  if (!factory) {
    return {
      label: `llm:unsupported:${config.providerType}`,
      errorReason: `Provider type "${config.providerType}" is not supported yet for provider "${config.provider}".`,
      providerContract: contract,
    };
  }

  return factory(config, contract);
}

function createOpenAICompatibleProvider(config: ResolvedLlmConfig, contract: ProviderContract): ModelFactoryResult {
  const apiKey = resolveProviderApiKey(config);

  if (providerRequiresApiKey(contract) && !apiKey) {
    return {
      label: `llm:missing-auth:${config.provider}`,
      errorReason: `Provider "${config.provider}" requires authentication, but no API key is configured.`,
      providerContract: contract,
    };
  }

  return {
    model: new OpenAICompatibleModel({
      provider: config.provider,
      apiKey,
      baseURL: config.baseURL,
      model: config.model,
      maxTokens: config.maxTokens,
      providerContract: contract,
    }),
    label: `llm:${config.provider}`,
    providerContract: contract,
  };
}

function createAnthropicProvider(config: ResolvedLlmConfig, contract: ProviderContract): ModelFactoryResult {
  const apiKey = resolveProviderApiKey(config);

  if (providerRequiresApiKey(contract) && !apiKey) {
    return {
      label: `llm:missing-auth:${config.provider}`,
      errorReason: `Provider "${config.provider}" requires authentication, but no API key is configured.`,
      providerContract: contract,
    };
  }

  return {
    model: new AnthropicModel({
      apiKey,
      baseURL: config.baseURL,
      model: config.model,
      maxTokens: config.maxTokens,
      providerContract: contract,
    }),
    label: `llm:${config.provider}`,
    providerContract: contract,
  };
}

function createGeminiProvider(config: ResolvedLlmConfig, contract: ProviderContract): ModelFactoryResult {
  const apiKey = resolveProviderApiKey(config);

  if (providerRequiresApiKey(contract) && !apiKey) {
    return {
      label: `llm:missing-auth:${config.provider}`,
      errorReason: `Provider "${config.provider}" requires authentication, but no API key is configured.`,
      providerContract: contract,
    };
  }

  return {
    model: new GeminiModel({
      apiKey,
      baseURL: config.baseURL,
      model: config.model,
      maxTokens: config.maxTokens,
      providerContract: contract,
    }),
    label: `llm:${config.provider}`,
    providerContract: contract,
  };
}

function resolveProviderApiKey(config: ResolvedLlmConfig): string {
  return config.authMode === "none"
    ? (config.apiKey || "ollama")
    : (config.apiKey ?? process.env.SHIGUANG_LLM_API_KEY ?? "");
}

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  PROVIDER_CONTRACT_VERSION,
  buildOpenAICompatibleCompletionModes,
  inferProviderContract,
  providerRequiresApiKey,
} from "./contract.js";

test("provider contract infers DeepSeek as OpenAI-compatible with native tool fallbacks", () => {
  const contract = inferProviderContract({
    provider: "deepseek",
    protocol: "openai-compatible",
    authMode: "api_key",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    maxTokens: 4096,
  });

  assert.equal(contract.version, PROVIDER_CONTRACT_VERSION);
  assert.equal(contract.provider, "deepseek");
  assert.equal(contract.protocol, "openai-compatible");
  assert.equal(contract.capabilities.nativeToolCalling, true);
  assert.equal(contract.capabilities.jsonObjectMode, true);
  assert.equal(contract.preferredRequestMode, "native_tools");
  assert.deepEqual(contract.fallbackRequestModes, ["json_object", "plain_json"]);
  assert.equal(contract.cost, "low");
  assert.equal(providerRequiresApiKey(contract), true);
  assert.deepEqual(buildOpenAICompatibleCompletionModes(contract, 2), ["native_tools", "json_object", "plain_json"]);
});

test("provider contract keeps local Ollama on plain JSON to avoid unsupported mode probes", () => {
  const contract = inferProviderContract({
    provider: "ollama",
    protocol: "openai-compatible",
    authMode: "none",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder:14b",
  });

  assert.equal(contract.authMode, "none");
  assert.equal(contract.capabilities.localTransport, true);
  assert.equal(contract.capabilities.nativeToolCalling, false);
  assert.equal(contract.capabilities.jsonObjectMode, false);
  assert.equal(contract.preferredRequestMode, "plain_json");
  assert.deepEqual(contract.fallbackRequestModes, []);
  assert.equal(contract.cost, "local");
  assert.equal(providerRequiresApiKey(contract), false);
  assert.deepEqual(buildOpenAICompatibleCompletionModes(contract, 4), ["plain_json"]);
});

test("provider contract captures Anthropic and Gemini prompt-shape differences", () => {
  const anthropic = inferProviderContract({
    provider: "anthropic",
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-latest",
  });
  const gemini = inferProviderContract({
    provider: "gemini",
    protocol: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
  });

  assert.equal(anthropic.preferredRequestMode, "anthropic_messages");
  assert.equal(anthropic.capabilities.nativeToolCalling, false);
  assert.equal(anthropic.capabilities.separateSystemPrompt, true);
  assert.equal(gemini.preferredRequestMode, "gemini_json");
  assert.equal(gemini.capabilities.jsonObjectMode, true);
  assert.equal(gemini.capabilities.separateSystemPrompt, true);
});

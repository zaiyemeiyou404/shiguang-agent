# Shiguang Provider Contract

This document defines how Shiguang Agent describes model providers before creating a concrete model adapter.

## Core idea

Shiguang now has a provider contract layer:

```text
desktop config -> ProviderContract -> planner factory -> model adapter -> model request
```

The contract is not a second model adapter. It is a normalized capability description shared by provider creation, request-mode selection, usage metadata, diagnostics, and future settings UI.

## Provider contract v1

Every provider is normalized into `shiguang.provider.contract.v1`.

| Field | Purpose |
|---|---|
| `version` | Current contract version, `shiguang.provider.contract.v1` |
| `provider` | Stable provider key such as `deepseek`, `openai`, `anthropic`, `gemini`, or `ollama` |
| `protocol` | Runtime protocol: `openai-compatible`, `anthropic`, or `gemini` |
| `authMode` | `api_key` or `none` |
| `baseURL` | Normalized endpoint root without trailing slash |
| `model` | Active model name |
| `maxOutputTokens` | Normalized output token cap |
| `capabilities` | Structured feature flags for tool calling, JSON mode, usage, prompt shape, local transport, and repair retry |
| `preferredRequestMode` | First mode to try for this provider |
| `fallbackRequestModes` | Ordered fallback modes |
| `cost` | Coarse planning cost class: `local`, `low`, `medium`, `high`, or `unknown` |
| `diagnostics` | Human-readable notes that can be surfaced by UI/debug logs |

Implementation:

- `src/brain/providers/contract.ts`
- `electron/planner-factory.ts`

## Request-mode selection

OpenAI-compatible providers no longer always start with native tools. The contract controls the mode sequence:

| Provider style | Mode sequence |
|---|---|
| OpenAI / DeepSeek / OpenRouter style | `native_tools -> json_object -> plain_json` |
| Local Ollama style | `plain_json` |

This avoids wasting requests on modes that are likely unsupported by a local OpenAI-compatible server.

Anthropic and Gemini still normalize into JSON action output for the Shiguang loop:

| Protocol | Preferred mode |
|---|---|
| `anthropic` | `anthropic_messages` |
| `gemini` | `gemini_json` |

## Relationship to Tool Contract

Provider Contract and Tool Contract solve different sides of the same harness problem:

- Provider Contract describes what the model endpoint can accept and return.
- Tool Contract describes what each executable capability can do inside the runtime.
- The planner sits between them: it selects a cost-aware subset of tool schemas, then sends them through a provider request mode that the contract says is supported.

## Current limitations

- Anthropic native tool use is not implemented yet; Anthropic currently uses strict JSON action output.
- Gemini function calling is not implemented yet; Gemini currently uses JSON MIME output.
- Streaming is described but disabled in all current contracts.
- Pricing is represented as coarse cost classes, not exact per-token pricing.

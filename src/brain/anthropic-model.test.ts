import { test } from "node:test";
import * as assert from "node:assert/strict";

import { AnthropicModel } from "./providers/anthropic.js";
import type { LlmPlannerModelRequest } from "./model-types.js";

function makeRequest(): LlmPlannerModelRequest {
  return {
    messages: [{ role: "user", content: "fix the failing typecheck" }],
    availableTools: [
      {
        name: "write_text_file",
        description: "Overwrite a text file",
        inputSchema: { type: "object" },
        effects: {
          workspaceMutation: true,
          validationMode: "all",
        },
      },
    ],
    history: [],
  };
}

test("AnthropicModel sends system prompt separately and parses JSON action text", async () => {
  const model = new AnthropicModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "claude-test" });
  let capturedBody = "";
  let capturedHeaders: HeadersInit | undefined;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ kind: "finish", content: "done" }) }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as {
      system?: string;
      messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    };
    assert.match(parsed.system ?? "", /write_text_file/);
    assert.equal(parsed.messages[0]?.role, "user");
    assert.equal(parsed.messages[0]?.content[0]?.text, "fix the failing typecheck");

    const headers = new Headers(capturedHeaders);
    assert.equal(headers.get("x-api-key"), "test-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

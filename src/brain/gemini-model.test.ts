import { test } from "node:test";
import * as assert from "node:assert/strict";

import { GeminiModel } from "./providers/gemini.js";
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

test("GeminiModel sends systemInstruction and parses JSON action text", async () => {
  const model = new GeminiModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1beta", model: "gemini-test" });
  let capturedUrl = "";
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ kind: "finish", content: "done" }) }] } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: { responseMimeType?: string };
    };
    assert.match(parsed.systemInstruction?.parts[0]?.text ?? "", /write_text_file/);
    assert.equal(parsed.contents[0]?.role, "user");
    assert.equal(parsed.contents[0]?.parts[0]?.text, "fix the failing typecheck");
    assert.equal(parsed.generationConfig.responseMimeType, "application/json");
    assert.match(capturedUrl, /models\/gemini-test:generateContent/);
    assert.match(capturedUrl, /[?&]key=test-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

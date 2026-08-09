import { test } from "node:test";
import * as assert from "node:assert/strict";

import { OpenAIModel } from "./openai-model.js";
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
      {
        name: "run_validation",
        description: "Run validation scripts",
        inputSchema: { type: "object" },
      },
    ],
    history: [],
  };
}

test("OpenAIModel includes tool effects in the system prompt", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
      tool_choice?: string;
      tools?: Array<{ function?: { name?: string; parameters?: Record<string, unknown> } }>;
    };
    const systemPrompt = parsed.messages.find((message) => message.role === "system")?.content ?? "";
    if (!/You are Shiguang Agent/.test(systemPrompt)) {
    assert.match(systemPrompt, /你是一个有帮助的 AI 代理/);
    assert.match(systemPrompt, /write_text_file/);
    assert.match(systemPrompt, /workspaceMutation=true/);
    assert.match(systemPrompt, /validationMode=all/);
    }
    assert.match(systemPrompt, /You are Shiguang Agent/);
    assert.match(systemPrompt, /write_text_file/);
    assert.match(systemPrompt, /workspaceMutation=true/);
    assert.match(systemPrompt, /validationMode=all/);
    assert.equal(parsed.response_format, undefined);
    assert.equal(parsed.tool_choice, "auto");
    assert.ok(parsed.tools?.some((tool) => tool.function?.name === "write_text_file"));
    assert.ok(parsed.tools?.some((tool) => tool.function?.name === "run_validation"));
    assert.equal(
      parsed.tools?.find((tool) => tool.function?.name === "write_text_file")?.function?.parameters?.type,
      "object",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel parses native tool calls from compatible providers", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "run_validation",
              arguments: JSON.stringify({ mode: "all" }),
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "tool_call");
    if (result.action.kind !== "tool_call") {
      assert.fail("expected tool_call action");
    }
    assert.equal(result.action.toolName, "run_validation");
    assert.deepEqual(result.action.toolInput, { mode: "all" });

    const parsed = JSON.parse(capturedBody) as {
      response_format?: unknown;
      tool_choice?: string;
      tools?: Array<{ function?: { name?: string } }>;
    };
    assert.equal(parsed.response_format, undefined);
    assert.equal(parsed.tool_choice, "auto");
    assert.ok(parsed.tools?.some((tool) => tool.function?.name === "run_validation"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel falls back to JSON mode when native tools are unsupported", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  const requestBodies: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    if (requestBodies.length === 1) {
      return new Response("tools are not supported by this endpoint", { status: 400 });
    }

    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");
    assert.equal(requestBodies.length, 2);

    const nativeRequest = JSON.parse(requestBodies[0] ?? "{}") as { tools?: unknown; response_format?: unknown };
    const fallbackRequest = JSON.parse(requestBodies[1] ?? "{}") as { tools?: unknown; response_format?: { type?: string } };
    assert.ok(Array.isArray(nativeRequest.tools));
    assert.equal(nativeRequest.response_format, undefined);
    assert.equal(fallbackRequest.tools, undefined);
    assert.equal(fallbackRequest.response_format?.type, "json_object");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel falls back to JSON mode when native tools return an empty message", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  const requestBodies: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    const body = requestBodies.length === 1
      ? { choices: [{ message: { content: "" } }] }
      : { choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");
    assert.equal(requestBodies.length, 2);

    const nativeRequest = JSON.parse(requestBodies[0] ?? "{}") as { tools?: unknown; response_format?: unknown };
    const fallbackRequest = JSON.parse(requestBodies[1] ?? "{}") as { tools?: unknown; response_format?: { type?: string } };
    assert.ok(Array.isArray(nativeRequest.tools));
    assert.equal(nativeRequest.response_format, undefined);
    assert.equal(fallbackRequest.tools, undefined);
    assert.equal(fallbackRequest.response_format?.type, "json_object");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel falls back to plain JSON prompting when json_object mode is empty", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  const requestBodies: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    const body = requestBodies.length < 3
      ? { choices: [{ message: { content: "" } }] }
      : { choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");
    assert.equal(requestBodies.length, 3);

    const nativeRequest = JSON.parse(requestBodies[0] ?? "{}") as { tools?: unknown; response_format?: unknown };
    const jsonRequest = JSON.parse(requestBodies[1] ?? "{}") as { tools?: unknown; response_format?: { type?: string } };
    const plainRequest = JSON.parse(requestBodies[2] ?? "{}") as { tools?: unknown; response_format?: unknown };
    assert.ok(Array.isArray(nativeRequest.tools));
    assert.equal(nativeRequest.response_format, undefined);
    assert.equal(jsonRequest.tools, undefined);
    assert.equal(jsonRequest.response_format?.type, "json_object");
    assert.equal(plainRequest.tools, undefined);
    assert.equal(plainRequest.response_format, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel retries once with a repair prompt after malformed output", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  const requestBodies: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    const body = requestBodies.length === 1
      ? { choices: [{ message: { content: "I think you should call the tool now" } }] }
      : { choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision(makeRequest());
    assert.equal(result.action.kind, "finish");
    assert.equal(requestBodies.length, 2);

    const repairedRequest = JSON.parse(requestBodies[1] ?? "{}") as { messages: Array<{ role: string; content: string }> };
    const lastMessage = repairedRequest.messages.at(-1)?.content ?? "";
    if (!/Return exactly one valid JSON object/.test(lastMessage)) {
    assert.match(lastMessage, /请只返回一个合法的 JSON 对象/);
    assert.match(lastMessage, /上一条回复不符合 agent 运行时要求/);
    }
    assert.match(lastMessage, /Return exactly one valid JSON object/);
    assert.match(lastMessage, /previous reply did not match the agent runtime contract/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel adds validation repair guidance when working memory shows a failed validation run", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 2,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "test",
          failingCommands: ["test"],
          summary: "Validation test failed.",
          stdoutSnippet: "FAILED tests/test_math.py::test_addition - AssertionError: assert 2 == 3\ntests/test_math.py:42: AssertionError",
          suspectFile: "tests/test_math.py",
          suspectLine: 42,
          failingTestName: "tests/test_math.py::test_addition",
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /mode=test/);
    assert.match(repairGuidance, /Failing commands: test/);
    assert.match(repairGuidance, /tests\/test_math.py::test_addition/);
    assert.match(repairGuidance, /Suspect file: tests\/test_math.py/);
    assert.match(repairGuidance, /Suspect line: 42/);
    assert.match(repairGuidance, /Failing test: tests\/test_math.py::test_addition/);
    assert.match(repairGuidance, /Do not finish yet/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes suspect column and import path in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 3,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "build",
          failingCommands: ["build"],
          summary: "Validation build failed.",
          stderrSnippet: "Module not found: Error: Can't resolve '@/components/Button' in '/workspace/src/pages'",
          suspectColumn: 20,
          suspectImportPath: "@/components/Button",
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /mode=build/);
    assert.match(repairGuidance, /Suspect column: 20/);
    assert.match(repairGuidance, /Suspect import path: @\/components\/Button/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes assert diff and export mismatch hints in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 4,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "test",
          failingCommands: ["test"],
          summary: "Validation test failed.",
          stdoutSnippet: "AssertionError: expected 2 to be 3",
          failingTestName: "src/utils/math.test.ts > math utils > adds numbers",
          suspectFile: "src/lib/math.ts",
          suspectLine: 8,
          suspectColumn: 11,
          assertExpected: "3",
          assertActual: "2",
          suspectExportName: "fetchUser",
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /Expected value: 3/);
    assert.match(repairGuidance, /Actual value: 2/);
    assert.match(repairGuidance, /Suspect export name: fetchUser/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes ranked root-cause and import style hints in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 5,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "all",
          failingCommands: ["test", "build"],
          summary: "Validation all failed.",
          stderrSnippet: "Attempted import error: './api' does not contain a default export (imported as 'api').",
          suspectFile: "./api",
          suspectExportName: "default",
          suspectImportStyle: "default",
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /mode=all/);
    assert.match(repairGuidance, /Failing commands: test, build/);
    assert.match(repairGuidance, /Suspect file: \.\/api/);
    assert.match(repairGuidance, /Suspect export name: default/);
    assert.match(repairGuidance, /Suspect import style: default/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes nested path diff summary in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 7,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "test",
          failingCommands: ["test"],
          summary: "Validation test failed.",
          stdoutSnippet: "AssertionError: expected nested payload to match snapshot",
          failingTestName: "src/features/todo/todo.test.ts > todo > normalizes nested payload",
          suspectFile: "src/features/todo/normalize-nested.ts",
          suspectLine: 18,
          suspectColumn: 5,
          assertExpected: '{\n  "user": {\n    "name": "Alice",\n    "stats": {\n      "count": 3\n    }\n  }\n}',
          assertActual: '{\n  "user": {\n    "name": "Bob",\n    "stats": {\n      "count": 2\n    }\n  }\n}',
          assertDiffSummary: 'Mismatched paths: user.name (expected "Alice", received "Bob"), user.stats.count (expected 3, received 2)',
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /Mismatched paths: user\.name \(expected "Alice", received "Bob"\), user\.stats\.count \(expected 3, received 2\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes snapshot diff summary in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 8,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "test",
          failingCommands: ["test"],
          summary: "Validation test failed.",
          stdoutSnippet: "AssertionError: expected snapshot to match",
          failingTestName: "src/features/todo/todo.test.ts > todo > renders snapshot",
          suspectFile: "src/features/todo/render-snapshot.ts",
          suspectLine: 14,
          suspectColumn: 4,
          assertDiffSummary: 'Snapshot diffs: status (removed "pending", added "done"), count (removed 2, added 3), owner (removed "bob", added "alice")',
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /Snapshot diffs: status \(removed "pending", added "done"\), count \(removed 2, added 3\), owner \(removed "bob", added "alice"\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes multiline diff summary in validation repair guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 6,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "test",
          failingCommands: ["test"],
          summary: "Validation test failed.",
          stdoutSnippet: "AssertionError: expected payload to match snapshot",
          failingTestName: "src/features/todo/todo.test.ts > todo > serializes payload",
          suspectFile: "src/features/todo/serialize.ts",
          suspectLine: 19,
          suspectColumn: 7,
          assertExpected: '{\n  "status": "done",\n  "count": 3\n}',
          assertActual: '{\n  "status": "pending",\n  "count": 2\n}',
          assertDiffSummary: 'Mismatched paths: status (expected "done", received "pending"), count (expected 3, received 2)',
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /Expected value: \{/);
    assert.match(repairGuidance, /Actual value: \{/);
    assert.match(repairGuidance, /Mismatched paths: status \(expected "done", received "pending"\), count \(expected 3, received 2\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIModel includes exhausted repair state and last strategy in validation guidance", async () => {
  const model = new OpenAIModel({ apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "fake-model" });
  let capturedBody = "";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "finish", content: "done" }) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await model.generateDecision({
      ...makeRequest(),
      workingMemory: {
        step: 9,
        lastActionKind: "tool_call",
        lastToolName: "run_validation",
        validationFailure: {
          mode: "typecheck",
          failingCommands: ["typecheck"],
          summary: "Validation typecheck failed.",
          stderrSnippet: "src/app.ts:1:7 - error TS2322",
          suspectFile: "src/app.ts",
          suspectLine: 1,
        },
        repairAttempt: {
          suspectFile: "src/app.ts",
          validationFailureCount: 2,
          editAttemptCount: 1,
          exhausted: true,
          lastStrategy: "patch_text_file",
          lastPatchSignature: JSON.stringify({
            tool: "patch_text_file",
            path: "src/app.ts",
            oldString: "const value: number = \"123\";",
            newString: "const value: number = 123;",
          }),
          triedStrategies: ["patch_text_file", "synthesized import/export style fix"],
          triedSuspectPaths: ["src/app.ts", "src/api.ts"],
          triedStrategyPaths: ["patch_text_file@src/app.ts", "synthesized import/export style fix@src/api.ts"],
          exhaustedSearchQuery: "fetchUser",
          exhaustedSearchCandidatePaths: ["src/services/user-api.ts"],
          exhaustedReadCandidatePaths: ["src/services/user-api.ts"],
        },
      },
    });
    assert.equal(result.action.kind, "finish");

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const repairGuidance = parsed.messages.find((message) => message.content.includes("Validation repair guidance:"))?.content ?? "";
    assert.match(repairGuidance, /validationFailureCount=2, editAttemptCount=1, exhausted=true/);
    assert.match(repairGuidance, /Last attempted deterministic repair strategy: patch_text_file/);
    assert.match(repairGuidance, /Last attempted patch signature:/);
    assert.match(repairGuidance, /Tried deterministic repair strategies: patch_text_file, synthesized import\/export style fix/);
    assert.match(repairGuidance, /Tried deterministic suspect paths: src\/app\.ts, src\/api\.ts/);
    assert.match(repairGuidance, /Tried deterministic strategy\/path pairs: patch_text_file@src\/app\.ts, synthesized import\/export style fix@src\/api\.ts/);
    assert.match(repairGuidance, /Exhausted-cycle search query: fetchUser/);
    assert.match(repairGuidance, /Exhausted-cycle ranked search candidates: src\/services\/user-api\.ts/);
    assert.match(repairGuidance, /Exhausted-cycle read search candidates: src\/services\/user-api\.ts/);
    assert.match(repairGuidance, /Do not repeat the same deterministic patch_text_file edit/);
    assert.match(repairGuidance, /prefer reading and considering that related file before final fail/);
    assert.match(repairGuidance, /use search_workspace before final fail to find related symbol\/module candidates/);
    assert.match(repairGuidance, /prefer reading a narrow non-node_modules, non-test candidate/);
    assert.match(repairGuidance, /after direct suspect paths and searched candidates are exhausted/);
    assert.match(repairGuidance, /Avoid immediately repeating a deterministic strategy\/path pair/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

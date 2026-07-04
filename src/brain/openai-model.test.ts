import { test } from "node:test";
import * as assert from "node:assert/strict";

import { OpenAIModel } from "./openai-model.js";
import type { LlmPlannerModelRequest } from "./planner.js";

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

    const parsed = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const systemPrompt = parsed.messages.find((message) => message.role === "system")?.content ?? "";
    assert.match(systemPrompt, /write_text_file/);
    assert.match(systemPrompt, /workspaceMutation=true/);
    assert.match(systemPrompt, /validationMode=all/);
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

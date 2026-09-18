import { test } from "node:test";
import * as assert from "node:assert/strict";
import { InMemoryEventSink } from "./event-sink.js";
import { redactEventPayload } from "./redact-event-payload.js";

test("event payload redaction removes credentials without changing ordinary tool data", () => {
  const payload = redactEventPayload({
    path: "src/index.ts",
    apiKey: "secret-value",
    headers: { Authorization: "Bearer top-secret", accept: "application/json" },
    nested: [{ cookie: "sid=abc" }, { content: "safe" }],
  }) as Record<string, unknown>;

  assert.equal(payload.path, "src/index.ts");
  assert.equal(payload.apiKey, "[REDACTED]");
  assert.deepEqual(payload.headers, { Authorization: "[REDACTED]", accept: "application/json" });
  assert.deepEqual(payload.nested, [{ cookie: "[REDACTED]" }, { content: "safe" }]);
});

test("in-memory events are sequenced independently for each run and persist only redacted payloads", async () => {
  const sink = new InMemoryEventSink();
  const first = await sink.record("run_a", "tool_call", { token: "do-not-store" });
  const other = await sink.record("run_b", "message", { content: "hello" });
  const second = await sink.record("run_a", "tool_result", { output: "done" });

  assert.equal(first.seq, 1);
  assert.equal(other.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(first.payload, { token: "[REDACTED]" });
});

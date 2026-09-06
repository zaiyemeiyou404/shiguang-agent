import assert from "node:assert/strict";
import test from "node:test";
import { startLocalAgentGateway, type LocalAgentGatewayService } from "./local-agent-gateway.js";

function fakeService() {
  const calls: Array<{ sessionId: string; message: string }> = [];
  const service: LocalAgentGatewayService = {
    async createSession(title) { return { id: "sess_test", title }; },
    async sendUserMessage(sessionId, message) {
      calls.push({ sessionId, message });
      return { id: "run_test", sessionId, status: "pending" };
    },
    async getSessionDetail(sessionId) { return { session: { id: sessionId }, runs: [], conversation: [] }; },
    async getRunEvents(runId) { return [{ id: "event_1", runId, kind: "message" }]; },
    async cancelRun(runId) { return { id: runId, status: "cancelled" }; },
  };
  return { service, calls };
}

test("binds only to loopback and rejects short tokens", async () => {
  const { service } = fakeService();
  await assert.rejects(() => startLocalAgentGateway(service, { host: "0.0.0.0", port: 0, token: "a".repeat(32) }), /loopback/);
  await assert.rejects(() => startLocalAgentGateway(service, { port: 0, token: "short" }), /at least 24/);
});

test("requires bearer authentication and forwards XDYou context as untrusted data", async () => {
  const { service, calls } = fakeService();
  const gateway = await startLocalAgentGateway(service, { port: 0, token: "t".repeat(32), logger: quietLogger });
  try {
    const unauthorized = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "明天有什么课" }),
    });
    assert.equal(unauthorized.status, 401);
    const authCheck = await fetch(`${gateway.baseUrl}/v1/auth-check`, {
      headers: { authorization: `Bearer ${gateway.token}` },
    });
    assert.equal(authCheck.status, 200);

    const response = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "总结明天安排", context: { courses: [{ name: "高等数学" }] } }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { sessionId: string; run: { id: string } };
    assert.equal(body.sessionId, "sess_test");
    assert.equal(body.run.id, "run_test");
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.message ?? "", /<xdyou_context>/);
    assert.match(calls[0]?.message ?? "", /untrusted data/);
    assert.match(calls[0]?.message ?? "", /高等数学/);
  } finally {
    await gateway.close();
  }
});

test("exposes session, event, cancellation, and health endpoints", async () => {
  const { service } = fakeService();
  const gateway = await startLocalAgentGateway(service, { port: 0, token: "t".repeat(32), logger: quietLogger });
  const headers = { authorization: `Bearer ${gateway.token}` };
  try {
    assert.equal((await fetch(`${gateway.baseUrl}/health`)).status, 200);
    const detail = await fetch(`${gateway.baseUrl}/v1/sessions/sess_test`, { headers });
    assert.equal(detail.status, 200);
    const events = await fetch(`${gateway.baseUrl}/v1/runs/run_test/events`, { headers });
    assert.equal(events.status, 200);
    const cancelled = await fetch(`${gateway.baseUrl}/v1/runs/run_test/cancel`, { method: "POST", headers });
    assert.equal(cancelled.status, 200);
  } finally {
    await gateway.close();
  }
});

test("rejects empty and oversized messages", async () => {
  const { service } = fakeService();
  const gateway = await startLocalAgentGateway(service, { port: 0, token: "t".repeat(32), logger: quietLogger });
  const headers = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" };
  try {
    const empty = await fetch(`${gateway.baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ message: "" }) });
    assert.equal(empty.status, 400);
    const large = await fetch(`${gateway.baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ message: "x".repeat(32_001) }) });
    assert.equal(large.status, 413);
    const invalid = await fetch(`${gateway.baseUrl}/v1/messages`, { method: "POST", headers, body: "{" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_json" });
  } finally {
    await gateway.close();
  }
});

const quietLogger = { info() {}, warn() {}, error() {} };

import assert from "node:assert/strict";
import test from "node:test";
import {
  createMcpToolAdaptersFromListedTools,
  inferMcpToolRisk,
  McpStdioMessageFramer,
  type McpToolClient,
} from "./index.js";

test("McpStdioMessageFramer parses newline-delimited JSON-RPC messages", () => {
  const framer = new McpStdioMessageFramer();
  const message = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';

  assert.deepEqual(framer.push(message.slice(0, 12)), []);
  assert.deepEqual(framer.push(message.slice(12)), [
    {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    },
  ]);
});

test("MCP listed tools become local tools with normalized names and approval risk", async () => {
  const calls: unknown[] = [];
  const client: McpToolClient = {
    async callTool(serverId, toolName, input) {
      calls.push({ serverId, toolName, input });
      return { ok: true };
    },
  };

  const [tool] = createMcpToolAdaptersFromListedTools("filesystem", [
    {
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      annotations: { destructiveHint: true },
    },
  ], client);

  assert.ok(tool);
  assert.equal(tool.descriptor.name, "mcp_filesystem_write_file");
  assert.equal(tool.descriptor.risk, "write");
  assert.equal(tool.descriptor.requiresApproval, true);
  assert.equal(tool.descriptor.capability, "mcp.filesystem.write_file");
  assert.deepEqual(await tool.execute({ path: "hello.txt" }), { ok: true });
  assert.deepEqual(calls, [{ serverId: "filesystem", toolName: "write_file", input: { path: "hello.txt" } }]);
});

test("MCP risk inference prefers annotations and falls back to tool names", () => {
  assert.equal(inferMcpToolRisk({ name: "read_file", annotations: { readOnlyHint: true } }), "read");
  assert.equal(inferMcpToolRisk({ name: "delete_file" }), "write");
  assert.equal(inferMcpToolRisk({ name: "run_command" }), "execute");
});

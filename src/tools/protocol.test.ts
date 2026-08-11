import { test } from "node:test";
import * as assert from "node:assert/strict";

import type { ToolDescriptor } from "./types.js";
import { createMcpToolAdapter, createMcpToolDescriptor, normalizeMcpToolName } from "./mcp-adapter.js";
import {
  TOOL_PROTOCOL_VERSION,
  describeToolForPrompt,
  inferToolProtocol,
} from "./protocol.js";

test("tool protocol classifies code inspection tools and recommends follow-up tools", () => {
  const descriptor: ToolDescriptor = {
    name: "code_map",
    description: "Build a compact map of the project.",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
    requiresApproval: false,
    capability: "code.map",
  };

  const protocol = inferToolProtocol(descriptor);
  assert.equal(protocol.version, TOOL_PROTOCOL_VERSION);
  assert.equal(protocol.source, "native");
  assert.equal(protocol.category, "code");
  assert.equal(protocol.phase, "inspect");
  assert.equal(protocol.risk, "read");
  assert.equal(protocol.approval, "never");
  assert.deepEqual(protocol.recommendedNextTools, ["symbol_search", "dependency_graph", "read_text_file"]);

  const promptLine = describeToolForPrompt(descriptor);
  assert.match(promptLine, /protocol=shiguang\.tool\.v1/);
  assert.match(promptLine, /category=code/);
});

test("workspace mutation tools are edit phase and approval-protected", () => {
  const descriptor: ToolDescriptor = {
    name: "write_text_file",
    description: "Write a UTF-8 text file.",
    inputSchema: { type: "object", properties: {} },
    effects: { workspaceMutation: true },
    requiresApproval: true,
    capability: "fs.write",
  };

  const protocol = inferToolProtocol(descriptor);
  assert.equal(protocol.category, "filesystem");
  assert.equal(protocol.phase, "edit");
  assert.equal(protocol.risk, "write");
  assert.equal(protocol.approval, "always");
  assert.deepEqual(protocol.recommendedNextTools, ["run_validation", "collect_diagnostics"]);
});

test("MCP adapter exposes external tools through the same internal descriptor shape", async () => {
  const calls: Array<{ serverId: string; toolName: string; input: unknown }> = [];
  const tool = createMcpToolAdapter({
    serverId: "github-server",
    name: "create_issue",
    description: "Create a GitHub issue.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    risk: "write",
  }, {
    async callTool(serverId, toolName, input) {
      calls.push({ serverId, toolName, input });
      return { created: true };
    },
  });

  assert.equal(tool.descriptor.name, "mcp_github-server_create_issue");
  assert.equal(tool.descriptor.capability, "mcp.github-server.create_issue");
  assert.equal(tool.descriptor.requiresApproval, true);

  const protocol = inferToolProtocol(tool.descriptor);
  assert.equal(protocol.source, "mcp-adapter");
  assert.equal(protocol.category, "mcp");
  assert.equal(protocol.risk, "write");

  const output = await tool.execute({ title: "Bug" });
  assert.deepEqual(output, { created: true });
  assert.deepEqual(calls, [{ serverId: "github-server", toolName: "create_issue", input: { title: "Bug" } }]);
});

test("MCP descriptor normalizes names and keeps explicit approval overrides", () => {
  const descriptor = createMcpToolDescriptor({
    serverId: "local files",
    name: "read/file",
    risk: "write",
    requiresApproval: false,
  });

  assert.equal(descriptor.name, "mcp_local_files_read_file");
  assert.equal(descriptor.requiresApproval, false);
  assert.equal(normalizeMcpToolName("weird server!", "tool name?"), "mcp_weird_server_tool_name");
});

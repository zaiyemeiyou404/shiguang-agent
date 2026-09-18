import test from "node:test";
import assert from "node:assert/strict";
import { checkToolPermission } from "./execution-policy.js";

const grant = { preset: "read_only" as const, allowRead: true, allowWrite: false, allowExecute: false, allowNetwork: false };

test("execution grant permits reads but blocks writes, terminal commands, and network tools", () => {
  assert.equal(checkToolPermission({ name: "read_text_file", description: "", inputSchema: {}, capability: "fs.read" }, { executionGrant: grant }).allowed, true);
  assert.equal(checkToolPermission({ name: "write_text_file", description: "", inputSchema: {}, capability: "fs.write" }, { executionGrant: grant }).allowed, false);
  assert.equal(checkToolPermission({ name: "run_terminal_command", description: "", inputSchema: {}, capability: "process.command" }, { executionGrant: grant }).allowed, false);
  assert.equal(checkToolPermission({ name: "web_search", description: "", inputSchema: {}, capability: "web.search" }, { executionGrant: grant }).allowed, false);
});

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ToolMetadataPolicy } from "./policy.js";
import type { BrainDecision } from "./types.js";

function makeToolDecision(toolName: string): BrainDecision {
  return {
    action: {
      kind: "tool_call",
      toolName,
      toolInput: {},
    },
    reasoning: `Use ${toolName}`,
  };
}

test("ToolMetadataPolicy allows read-only tools without approval", async () => {
  const policy = new ToolMetadataPolicy([
    { name: "read_text_file", description: "read", inputSchema: {}, risk: "read", requiresApproval: false, capability: "fs.read" },
  ]);

  const decision = makeToolDecision("read_text_file");
  const result = await policy.check(decision);
  assert.deepEqual(result, decision);
});

test("ToolMetadataPolicy blocks tools marked as requiring approval", async () => {
  const policy = new ToolMetadataPolicy([
    { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write" },
  ]);

  const result = await policy.check(makeToolDecision("write_text_file"));
  assert.equal(result.action.kind, "needs_approval");
  assert.equal(result.action.toolName, "write_text_file");
  assert.equal(result.action.capability, "fs.write");
  assert.equal(result.action.approvalId, undefined);
  assert.match(result.action.reason ?? "", /write_text_file/);
  assert.match(result.action.reason ?? "", /fs\.write/);
});

test("ToolMetadataPolicy keeps explicit allow-without-approval exceptions", async () => {
  const policy = new ToolMetadataPolicy([
    { name: "run_validation", description: "validate", inputSchema: {}, risk: "execute", requiresApproval: true, capability: "process.validate" },
  ]);

  const result = await policy.check(makeToolDecision("run_validation"));
  assert.equal(result.action.kind, "tool_call");
  assert.equal(result.action.toolName, "run_validation");
});

test("ToolMetadataPolicy supports configured workspace edit exceptions", async () => {
  const policy = new ToolMetadataPolicy([
    { name: "write_text_file", description: "write", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write" },
    { name: "patch_text_file", description: "patch", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.write" },
    { name: "delete_path", description: "delete", inputSchema: {}, risk: "write", requiresApproval: true, capability: "fs.delete" },
  ], {
    allowWithoutApproval: ["run_validation", "write_text_file", "patch_text_file"],
  });

  const writeResult = await policy.check(makeToolDecision("write_text_file"));
  const patchResult = await policy.check(makeToolDecision("patch_text_file"));
  const deleteResult = await policy.check(makeToolDecision("delete_path"));

  assert.equal(writeResult.action.kind, "tool_call");
  assert.equal(patchResult.action.kind, "tool_call");
  assert.equal(deleteResult.action.kind, "needs_approval");
});

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { ActionDispatcher } from "./dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

function makeWorkspaceMutatingTool(): Tool {
  return {
    descriptor: {
      name: "write_fixture",
      description: "Pretend to update a workspace file.",
      inputSchema: { type: "object" },
      effects: {
        workspaceMutation: true,
        validationMode: "all",
      },
    },
    async execute(): Promise<unknown> {
      return { ok: true };
    },
  };
}

test("ActionDispatcher marks successful workspace mutations for follow-up validation", async () => {
  const registry = new ToolRegistry();
  registry.register(makeWorkspaceMutatingTool());
  const dispatcher = new ActionDispatcher(registry);

  const result = await dispatcher.dispatch({
    action: { kind: "tool_call", toolName: "write_fixture", toolInput: { path: "src/app.ts" } },
    reasoning: "Update a source file.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.metadata?.category, "tool_observation");
  assert.equal(result.metadata?.toolName, "write_fixture");
  assert.equal(result.metadata?.workspaceMutation, true);
  assert.equal(result.metadata?.validationMode, "all");
});

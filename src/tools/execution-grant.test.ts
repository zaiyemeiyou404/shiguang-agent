import test from "node:test";
import assert from "node:assert/strict";
import { executionGrantForPreset, normalizeExecutionPreset } from "./execution-grant.js";

test("execution presets keep distinct write, network, and host permissions", () => {
  const readOnly = executionGrantForPreset("read_only", "G:/work");
  const workspaceWrite = executionGrantForPreset("workspace_write", "G:/work");
  const workspaceNetwork = executionGrantForPreset("workspace_write_network", "G:/work");
  const fullAccess = executionGrantForPreset("full_access", "G:/work");

  assert.deepEqual(
    [readOnly.allowWrite, readOnly.allowExecute, readOnly.allowNetwork, readOnly.allowHostExecute],
    [false, false, false, false],
  );
  assert.deepEqual(
    [workspaceWrite.allowWrite, workspaceWrite.allowExecute, workspaceWrite.allowNetwork, workspaceWrite.allowHostExecute],
    [true, true, false, false],
  );
  assert.deepEqual(
    [workspaceNetwork.allowWrite, workspaceNetwork.allowExecute, workspaceNetwork.allowNetwork, workspaceNetwork.allowHostExecute],
    [true, true, true, false],
  );
  assert.deepEqual(
    [fullAccess.allowWrite, fullAccess.allowExecute, fullAccess.allowNetwork, fullAccess.allowHostExecute],
    [true, true, true, true],
  );
  assert.notDeepEqual(
    [workspaceNetwork.allowExecute, workspaceNetwork.allowNetwork, workspaceNetwork.allowHostExecute],
    [fullAccess.allowExecute, fullAccess.allowNetwork, fullAccess.allowHostExecute],
  );
});

test("unknown execution presets fall back without collapsing the saved network preset", () => {
  assert.equal(normalizeExecutionPreset("workspace_write_network"), "workspace_write_network");
  assert.equal(normalizeExecutionPreset("nope"), "workspace_write_network");
  assert.equal(normalizeExecutionPreset("full_access"), "full_access");
});

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  SHIGUANG_USER_DATA_DIR_NAME,
  WORKSPACE_POLICY_VERSION,
  describeWorkspacePolicy,
  resolveConfigPathFromPolicy,
  resolveProjectRootFromAppPath,
  resolveWorkspacePolicy,
  resolveWorkspaceRootFromPolicy,
} from "./policy.js";

test("workspace policy keeps development data inside the project data directory", () => {
  const policy = resolveWorkspacePolicy({
    env: {},
    appPath: "G:/repo/desktop-build",
    execPath: "G:/repo/node_modules/electron/dist/electron.exe",
    appDataPath: "C:/Users/A/AppData/Roaming",
    isPackaged: false,
  });

  assert.equal(policy.version, WORKSPACE_POLICY_VERSION);
  assert.equal(policy.userDataRootSource, "development_project");
  assert.match(policy.userDataRoot.replace(/\\/g, "/"), /G:\/repo\/shiguang-agent-data$/);
  assert.match(policy.configPath.replace(/\\/g, "/"), /shiguang-agent-data\/shiguang\.config\.json$/);
  assert.match(policy.memoryDbPath.replace(/\\/g, "/"), /shiguang-agent-data\/memory\/shiguang-memory\.sqlite$/);
  assert.match(policy.defaultWorkspaceRoot.replace(/\\/g, "/"), /shiguang-agent-data\/workspace$/);
  assert.equal(policy.legacyUserDataSources.length, 2);
});

test("workspace policy prefers build-output project data for local packaged release folders", () => {
  const policy = resolveWorkspacePolicy({
    env: {},
    appPath: "G:/repo/release/win-unpacked/resources/app.asar",
    execPath: "G:/repo/release/win-unpacked/拾光 Agent.exe",
    isPackaged: true,
    preferredDataRoot: "G:/CodexData",
  });

  assert.equal(policy.userDataRootSource, "packaged_build_output");
  assert.match(policy.userDataRoot.replace(/\\/g, "/"), /G:\/repo\/shiguang-agent-data$/);
  assert.match(policy.packagedExecutableDataRoot?.replace(/\\/g, "/") ?? "", /G:\/repo\/release\/win-unpacked\/shiguang-agent-data$/);
});

test("workspace policy uses preferred packaged data root for installed apps", () => {
  const policy = resolveWorkspacePolicy({
    env: {},
    appPath: "C:/Program Files/Shiguang/resources/app.asar",
    execPath: "C:/Program Files/Shiguang/拾光 Agent.exe",
    isPackaged: true,
    preferredDataRoot: "G:/CodexData",
  });

  assert.equal(policy.userDataRootSource, "packaged_preferred_root");
  assert.match(policy.userDataRoot.replace(/\\/g, "/"), /G:\/CodexData\/shiguang-agent-data$/);
});

test("workspace policy env overrides win over packaged defaults", () => {
  const policy = resolveWorkspacePolicy({
    env: { SHIGUANG_USER_DATA_DIR: "D:/custom-data" },
    appPath: "C:/Program Files/Shiguang/resources/app.asar",
    execPath: "C:/Program Files/Shiguang/拾光 Agent.exe",
    isPackaged: true,
    preferredDataRoot: "G:/CodexData",
  });

  assert.equal(policy.userDataRootSource, "env");
  assert.match(policy.userDataRoot.replace(/\\/g, "/"), /D:\/custom-data$/);
});

test("workspace root and config path are resolved from policy plus explicit overrides", () => {
  const policy = resolveWorkspacePolicy({
    env: {},
    appPath: "G:/repo",
    execPath: "G:/repo/node_modules/electron/dist/electron.exe",
    isPackaged: false,
  });

  assert.equal(
    resolveWorkspaceRootFromPolicy({ userDataRoot: policy.userDataRoot, configuredWorkspaceRoot: "G:/work" }).replace(/\\/g, "/"),
    "G:/work",
  );
  assert.equal(
    resolveWorkspaceRootFromPolicy({ env: { SHIGUANG_WORKSPACE_ROOT: "G:/env-work" }, userDataRoot: policy.userDataRoot }).replace(/\\/g, "/"),
    "G:/env-work",
  );
  assert.equal(
    resolveConfigPathFromPolicy(policy, { SHIGUANG_CONFIG_PATH: "G:/config/shiguang.json" }).replace(/\\/g, "/"),
    "G:/config/shiguang.json",
  );
});

test("workspace policy description is compact and stable", () => {
  const policy = resolveWorkspacePolicy({
    env: {},
    appPath: "G:/repo",
    execPath: "G:/repo/node_modules/electron/dist/electron.exe",
    isPackaged: false,
  });

  const description = describeWorkspacePolicy(policy);
  assert.match(description, /shiguang\.workspace\.policy\.v1/);
  assert.match(description, /source=development_project/);
  assert.match(description, new RegExp(SHIGUANG_USER_DATA_DIR_NAME));
});

test("project root resolver strips desktop-build in dev electron builds", () => {
  assert.match(resolveProjectRootFromAppPath("G:/repo/desktop-build").replace(/\\/g, "/"), /G:\/repo$/);
  assert.match(resolveProjectRootFromAppPath("G:/repo").replace(/\\/g, "/"), /G:\/repo$/);
});

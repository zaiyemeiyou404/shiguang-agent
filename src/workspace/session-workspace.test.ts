import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  defaultSessionWorkspaceRoot,
  dedicatedSessionWorkspaceRoot,
  legacySessionWorkspaceParent,
  normalizeWorkspacePath,
  resolveSessionWorkspaceRoot,
} from "./session-workspace.js";

test("default sessions are isolated only inside the app-managed workspace", () => {
  const managedWorkspace = join("tmp", "shiguang-agent-data", "workspace");
  const externalProject = join("tmp", "projects", "demo");

  assert.equal(
    defaultSessionWorkspaceRoot({
      baseWorkspaceRoot: managedWorkspace,
      defaultWorkspaceRoot: managedWorkspace,
      sessionId: "sess_1",
    }),
    dedicatedSessionWorkspaceRoot(managedWorkspace, "sess_1"),
  );

  assert.equal(
    defaultSessionWorkspaceRoot({
      baseWorkspaceRoot: externalProject,
      defaultWorkspaceRoot: managedWorkspace,
      sessionId: "sess_1",
    }),
    normalizeWorkspacePath(externalProject),
  );
});

test("legacy hidden session workspace under an external project is repaired to the project root", () => {
  const managedWorkspace = join("tmp", "shiguang-agent-data", "workspace");
  const externalProject = join("tmp", "projects", "demo");
  const legacyWorkspace = dedicatedSessionWorkspaceRoot(externalProject, "sess_2");

  assert.equal(legacySessionWorkspaceParent(legacyWorkspace, "sess_2"), normalizeWorkspacePath(externalProject));
  assert.equal(
    resolveSessionWorkspaceRoot({
      baseWorkspaceRoot: managedWorkspace,
      defaultWorkspaceRoot: managedWorkspace,
      sessionId: "sess_2",
      existingSessionWorkspaceRoot: legacyWorkspace,
    }),
    normalizeWorkspacePath(externalProject),
  );
});

test("legacy hidden session workspace under the managed default stays isolated", () => {
  const managedWorkspace = join("tmp", "shiguang-agent-data", "workspace");
  const legacyWorkspace = dedicatedSessionWorkspaceRoot(managedWorkspace, "sess_3");

  assert.equal(
    resolveSessionWorkspaceRoot({
      baseWorkspaceRoot: managedWorkspace,
      defaultWorkspaceRoot: managedWorkspace,
      sessionId: "sess_3",
      existingSessionWorkspaceRoot: legacyWorkspace,
    }),
    legacyWorkspace,
  );
});

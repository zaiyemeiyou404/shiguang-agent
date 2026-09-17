import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROJECT_ID, DEFAULT_WORKSPACE_ID, MIGRATION_001, SCHEMA_VERSION } from "./schema.js";
import { initializeStateDatabase } from "./sqlite.js";
import { SqliteProjectRepository } from "./sqlite-project-repository.js";
import { SqliteSessionRepository } from "./sqlite-session-repository.js";
import { SqliteWorkspaceRepository } from "./sqlite-workspace-repository.js";

test("initializeStateDatabase migrates version 1 sessions into the default workspace", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION_001);
  db.prepare(`
    INSERT INTO sessions (id, title, status, created_at, updated_at, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("session-before-workspaces", "旧会话", "active", "2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z", null);

  initializeStateDatabase(db);

  const version = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
  const project = db.prepare("SELECT id, name FROM projects WHERE id = ?").get(DEFAULT_PROJECT_ID) as { id: string; name: string };
  const workspace = db.prepare("SELECT id, project_id, name, root_path FROM workspaces WHERE id = ?").get(DEFAULT_WORKSPACE_ID) as {
    id: string;
    project_id: string;
    name: string;
    root_path: string;
  };
  const session = db.prepare("SELECT workspace_id FROM sessions WHERE id = ?").get("session-before-workspaces") as { workspace_id: string };

  assert.equal(version.version, SCHEMA_VERSION);
  assert.equal(project.id, DEFAULT_PROJECT_ID);
  assert.equal(project.name, "默认项目");
  assert.equal(workspace.id, DEFAULT_WORKSPACE_ID);
  assert.equal(workspace.project_id, DEFAULT_PROJECT_ID);
  assert.equal(workspace.name, "默认工作区");
  assert.equal(workspace.root_path, "");
  assert.equal(session.workspace_id, DEFAULT_WORKSPACE_ID);
  db.close();
});

test("repositories persist a session under its selected workspace", async () => {
  const db = new DatabaseSync(":memory:");
  initializeStateDatabase(db);
  const projects = new SqliteProjectRepository(db);
  const workspaces = new SqliteWorkspaceRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const now = new Date("2026-09-16T00:00:00.000Z");

  await projects.create({ id: "project_alpha", name: "Alpha", createdAt: now, updatedAt: now });
  await workspaces.create({
    id: "workspace_alpha",
    projectId: "project_alpha",
    name: "Alpha workspace",
    rootPath: "G:\\projects\\alpha",
    createdAt: now,
    updatedAt: now,
  });
  await sessions.create({
    id: "session_alpha",
    workspaceId: "workspace_alpha",
    title: "Bound session",
    status: "active",
    createdAt: now,
    updatedAt: now,
    summary: null,
  });

  assert.equal((await projects.get("project_alpha"))?.name, "Alpha");
  assert.equal((await workspaces.listByProject("project_alpha"))[0]?.rootPath, "G:\\projects\\alpha");
  assert.equal((await sessions.get("session_alpha"))?.workspaceId, "workspace_alpha");
  db.close();
});

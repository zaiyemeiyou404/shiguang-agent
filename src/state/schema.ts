export const SCHEMA_VERSION = 7;
export const DEFAULT_PROJECT_ID = "project_default";
export const DEFAULT_WORKSPACE_ID = "workspace_default";

export const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

INSERT INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  model TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global',
  workspace_scope TEXT,
  kind TEXT NOT NULL DEFAULT 'observation',
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0.0,
  last_accessed_at TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_links (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_json TEXT NOT NULL DEFAULT '{}',
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_task_started ON runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, plugin_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_type, target_id);
`;

export const MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO projects (id, name)
VALUES ('${DEFAULT_PROJECT_ID}', '默认项目');

INSERT OR IGNORE INTO workspaces (id, project_id, name, root_path)
VALUES ('${DEFAULT_WORKSPACE_ID}', '${DEFAULT_PROJECT_ID}', '默认工作区', '');

ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

UPDATE sessions
SET workspace_id = '${DEFAULT_WORKSPACE_ID}'
WHERE workspace_id IS NULL OR workspace_id = '';

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);

`;

export const MIGRATION_003 = `
CREATE TRIGGER IF NOT EXISTS sessions_workspace_required_insert
BEFORE INSERT ON sessions
WHEN NEW.workspace_id IS NULL OR trim(NEW.workspace_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'session workspace_id is required');
END;

CREATE TRIGGER IF NOT EXISTS sessions_workspace_immutable
BEFORE UPDATE OF workspace_id ON sessions
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'session workspace_id cannot be changed');
END;

`;

export const MIGRATION_004 = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  payload_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_created
ON task_checkpoints(task_id, created_at);

`;

export const MIGRATION_005 = `
ALTER TABLE runs ADD COLUMN budget_json TEXT DEFAULT '{}';
`;

export const MIGRATION_006 = `
ALTER TABLE approvals ADD COLUMN scope TEXT NOT NULL DEFAULT 'once';
`;

export const MIGRATION_007 = `
CREATE TABLE IF NOT EXISTS legacy_runtime_imports (
  source_key TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
);
`;

export interface StateMigration {
  version: number;
  name: string;
  sql: string;
  requiresBackup?: boolean;
}

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  { version: 1, name: "initial-state", sql: MIGRATION_001 },
  { version: 2, name: "projects-and-workspaces", sql: MIGRATION_002 },
  { version: 3, name: "session-workspace-constraints", sql: MIGRATION_003 },
  { version: 4, name: "task-checkpoints", sql: MIGRATION_004 },
  { version: 5, name: "run-budgets", sql: MIGRATION_005 },
  { version: 6, name: "approval-scopes", sql: MIGRATION_006 },
  { version: 7, name: "legacy-runtime-import-markers", sql: MIGRATION_007 },
];

/** @deprecated Prefer STATE_MIGRATIONS so version and backup metadata remain explicit. */
export const ALL_MIGRATIONS = STATE_MIGRATIONS.map((migration) => migration.sql);

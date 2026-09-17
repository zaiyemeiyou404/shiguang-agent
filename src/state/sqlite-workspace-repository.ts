import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Workspace } from "../core/types.js";
import type { WorkspaceRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type WorkspaceRow = {
  id: string;
  project_id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, project_id, name, root_path, created_at, updated_at";
const PATCH_COLUMNS = {
  projectId: "project_id",
  name: "name",
  rootPath: "root_path",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies Partial<Record<keyof Workspace, string>>;

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(workspace: Workspace): Promise<void> {
    this.db.prepare(`
      INSERT INTO workspaces (id, project_id, name, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      workspace.id,
      workspace.projectId,
      workspace.name,
      workspace.rootPath,
      workspace.createdAt.toISOString(),
      workspace.updatedAt.toISOString(),
    );
  }

  async get(id: string): Promise<Workspace | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`).get(id) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  async update(id: string, patch: Partial<Workspace>): Promise<void> {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof typeof PATCH_COLUMNS, string]>) {
      if (field in patch && patch[field] !== undefined) {
        assignments.push(`${column} = ?`);
        const value = patch[field];
        values.push(value instanceof Date ? value.toISOString() : value as SQLInputValue);
      }
    }
    if (assignments.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE workspaces SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async list(): Promise<Workspace[]> {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM workspaces ORDER BY updated_at DESC, id ASC`).all() as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  async listByProject(projectId: string): Promise<Workspace[]> {
    const rows = this.db.prepare(`
      SELECT ${COLUMNS} FROM workspaces WHERE project_id = ? ORDER BY updated_at DESC, id ASC
    `).all(projectId) as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

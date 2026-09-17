import type { DatabaseSync } from "node:sqlite";
import type { Project } from "../core/types.js";
import type { ProjectRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export class SqliteProjectRepository implements ProjectRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(project: Project): Promise<void> {
    this.db.prepare(`
      INSERT INTO projects (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(project.id, project.name, project.createdAt.toISOString(), project.updatedAt.toISOString());
  }

  async get(id: string): Promise<Project | null> {
    const row = this.db.prepare(`
      SELECT id, name, created_at, updated_at FROM projects WHERE id = ?
    `).get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  async list(): Promise<Project[]> {
    const rows = this.db.prepare(`
      SELECT id, name, created_at, updated_at FROM projects
      ORDER BY updated_at DESC, id ASC
    `).all() as ProjectRow[];
    return rows.map(rowToProject);
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

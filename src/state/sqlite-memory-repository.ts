import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Memory, MemoryKind, MemoryScope } from "../core/types.js";
import type { MemoryRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type MemoryRow = {
  id: string;
  scope: string;
  workspace_scope: string | null;
  kind: string;
  summary: string;
  content: string;
  salience: number;
  last_accessed_at: string | null;
  source_type: Memory["sourceType"];
  source_id: string;
  confidence: number;
  created_at: string;
  updated_at: string;
};

const MEMORY_COLUMNS = `
  id,
  scope,
  workspace_scope,
  kind,
  summary,
  content,
  salience,
  last_accessed_at,
  source_type,
  source_id,
  confidence,
  created_at,
  updated_at
`;

const PATCH_COLUMNS = {
  scope: "scope",
  workspaceScope: "workspace_scope",
  kind: "kind",
  summary: "summary",
  content: "content",
  salience: "salience",
  lastAccessedAt: "last_accessed_at",
  sourceType: "source_type",
  sourceId: "source_id",
  confidence: "confidence",
  createdAt: "created_at",
} as const satisfies Partial<Record<keyof Memory, string>>;

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(memory: Memory): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO memories (
          id,
          scope,
          workspace_scope,
          kind,
          summary,
          content,
          salience,
          last_accessed_at,
          source_type,
          source_id,
          confidence,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.scope,
        memory.workspaceScope,
        memory.kind,
        memory.summary,
        memory.content,
        memory.salience,
        toSqlDate(memory.lastAccessedAt),
        memory.sourceType,
        memory.sourceId,
        memory.confidence,
        toSqlDate(memory.createdAt),
        toSqlDate(memory.updatedAt),
      );
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`)
      .get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  async update(id: string, patch: Partial<Memory>): Promise<void> {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];

    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<
      [keyof typeof PATCH_COLUMNS, string]
    >) {
      if (field in patch && patch[field] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(toSqlValue(patch[field]));
      }
    }

    assignments.push("updated_at = ?");
    values.push(toSqlDate(new Date()), id);

    this.db.prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  async search(scope: string, query: string, limit = 10): Promise<Memory[]> {
    const normalizedLimit = normalizeLimit(limit);
    const q = query.trim();
    const rows = q
      ? (this.db
          .prepare(`
            SELECT ${MEMORY_COLUMNS}
            FROM memories
            WHERE scope = ?
              AND (summary LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
            ORDER BY salience DESC, updated_at DESC
            LIMIT ?
          `)
          .all(scope, likePattern(q), likePattern(q), normalizedLimit) as MemoryRow[])
      : (this.db
          .prepare(`
            SELECT ${MEMORY_COLUMNS}
            FROM memories
            WHERE scope = ?
            ORDER BY salience DESC, updated_at DESC
            LIMIT ?
          `)
          .all(scope, normalizedLimit) as MemoryRow[]);

    return rows.map(rowToMemory);
  }

  async listByWorkspace(workspaceScope: string, limit = 10): Promise<Memory[]> {
    const rows = this.db
      .prepare(`
        SELECT ${MEMORY_COLUMNS}
        FROM memories
        WHERE workspace_scope = ?
        ORDER BY salience DESC, updated_at DESC
        LIMIT ?
      `)
      .all(workspaceScope, normalizeLimit(limit)) as MemoryRow[];
    return rows.map(rowToMemory);
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    workspaceScope: row.workspace_scope,
    kind: row.kind as MemoryKind,
    summary: row.summary,
    content: row.content,
    salience: row.salience,
    lastAccessedAt: fromSqlDate(row.last_accessed_at),
    sourceType: row.source_type,
    sourceId: row.source_id,
    confidence: row.confidence,
    createdAt: fromRequiredSqlDate(row.created_at),
    updatedAt: fromRequiredSqlDate(row.updated_at),
  };
}

function toSqlValue(value: Memory[keyof Memory] | undefined): SQLInputValue {
  if (value === undefined) return null;
  return value instanceof Date ? toSqlDate(value) : value;
}

function toSqlDate(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function fromSqlDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function fromRequiredSqlDate(value: string): Date {
  return new Date(value);
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

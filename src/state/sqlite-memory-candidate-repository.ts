import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { MemoryCandidate, MemoryCandidateStatus, MemoryKind, MemoryScope } from "../core/types.js";
import type { MemoryCandidateRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type CandidateRow = {
  id: string; scope: string; workspace_scope: string | null; kind: string; summary: string; content: string;
  salience: number; source_type: MemoryCandidate["sourceType"]; source_id: string; confidence: number;
  status: string; created_at: string; updated_at: string; resolved_at: string | null;
};

const COLUMNS = "id, scope, workspace_scope, kind, summary, content, salience, source_type, source_id, confidence, status, created_at, updated_at, resolved_at";
const PATCH_COLUMNS = {
  scope: "scope", workspaceScope: "workspace_scope", kind: "kind", summary: "summary", content: "content",
  salience: "salience", sourceType: "source_type", sourceId: "source_id", confidence: "confidence", status: "status", resolvedAt: "resolved_at",
} as const satisfies Partial<Record<keyof MemoryCandidate, string>>;

export class SqliteMemoryCandidateRepository implements MemoryCandidateRepository {
  private readonly db: DatabaseSync;
  constructor(dbOrPath: DatabaseSync | string) { this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath; }
  async create(candidate: MemoryCandidate): Promise<void> {
    this.db.prepare(`INSERT INTO memory_candidates (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      candidate.id, candidate.scope, candidate.workspaceScope, candidate.kind, candidate.summary, candidate.content,
      candidate.salience, candidate.sourceType, candidate.sourceId, candidate.confidence, candidate.status,
      candidate.createdAt.toISOString(), candidate.updatedAt.toISOString(), toDate(candidate.resolvedAt),
    );
  }
  async get(id: string): Promise<MemoryCandidate | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM memory_candidates WHERE id = ?`).get(id) as CandidateRow | undefined;
    return row ? fromRow(row) : null;
  }
  async update(id: string, patch: Partial<MemoryCandidate>): Promise<void> {
    const assignments: string[] = []; const values: SQLInputValue[] = [];
    for (const [field, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof typeof PATCH_COLUMNS, string]>) {
      if (field in patch && patch[field] !== undefined) { assignments.push(`${column} = ?`); values.push(toValue(patch[field])); }
    }
    assignments.push("updated_at = ?"); values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE memory_candidates SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }
  async listPendingByWorkspace(workspaceScope: string, limit = 100): Promise<MemoryCandidate[]> {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM memory_candidates WHERE workspace_scope = ? AND status = 'pending' ORDER BY updated_at DESC LIMIT ?`).all(workspaceScope, normalizeLimit(limit)) as CandidateRow[];
    return rows.map(fromRow);
  }
}
function fromRow(row: CandidateRow): MemoryCandidate { return { id: row.id, scope: row.scope as MemoryScope, workspaceScope: row.workspace_scope, kind: row.kind as MemoryKind, summary: row.summary, content: row.content, salience: row.salience, sourceType: row.source_type, sourceId: row.source_id, confidence: row.confidence, status: row.status as MemoryCandidateStatus, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null }; }
function toDate(value: Date | null): string | null { return value?.toISOString() ?? null; }
function toValue(value: MemoryCandidate[keyof MemoryCandidate] | undefined): SQLInputValue { return value instanceof Date ? value.toISOString() : value ?? null; }
function normalizeLimit(limit: number): number { return Math.max(1, Math.min(100, Math.trunc(limit))); }

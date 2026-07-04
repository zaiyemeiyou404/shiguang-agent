import type { DatabaseSync } from "node:sqlite";
import type { Turn } from "../core/types.js";
import type { TurnRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type TurnRow = {
  id: string;
  session_id: string;
  role: Turn["role"];
  content: string;
  created_at: string;
};

const TURN_COLUMNS = `
  id,
  session_id,
  role,
  content,
  created_at
`;

export class SqliteTurnRepository implements TurnRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(turn: Turn): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO turns (
          id,
          session_id,
          role,
          content,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        turn.id,
        turn.sessionId,
        turn.role,
        turn.content,
        toSqlDate(turn.createdAt),
      );
  }

  async listBySession(sessionId: string, limit = 20): Promise<Turn[]> {
    const rows = this.db
      .prepare(`
        SELECT ${TURN_COLUMNS}
        FROM turns
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(sessionId, normalizeLimit(limit)) as TurnRow[];

    return rows.reverse().map(rowToTurn);
  }
}

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at),
  };
}

function toSqlDate(date: Date): string {
  return date.toISOString();
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

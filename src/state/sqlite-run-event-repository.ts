import type { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunEventKind } from "../core/types.js";
import type { RunEventRepository } from "./repositories.js";
import { openStateDatabase } from "./sqlite.js";

type RunEventRow = {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  payload_json: string;
  created_at: string;
};

const RUN_EVENT_COLUMNS = `
  id,
  run_id,
  seq,
  kind,
  payload_json,
  created_at
`;

export class SqliteRunEventRepository implements RunEventRepository {
  private readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string) {
    this.db = typeof dbOrPath === "string" ? openStateDatabase(dbOrPath) : dbOrPath;
  }

  async create(event: RunEvent): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO run_events (
          id,
          run_id,
          seq,
          kind,
          payload_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.runId,
        event.seq,
        event.kind,
        JSON.stringify(event.payload ?? null),
        toSqlDate(event.createdAt),
      );
  }

  async listByRun(runId: string): Promise<RunEvent[]> {
    const rows = this.db
      .prepare(`
        SELECT ${RUN_EVENT_COLUMNS}
        FROM run_events
        WHERE run_id = ?
        ORDER BY seq ASC, created_at ASC, id ASC
      `)
      .all(runId) as RunEventRow[];

    return rows.map(rowToRunEvent);
  }
}

function rowToRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind as RunEventKind,
    payload: JSON.parse(row.payload_json),
    createdAt: new Date(row.created_at),
  };
}

function toSqlDate(date: Date): string {
  return date.toISOString();
}

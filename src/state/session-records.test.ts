import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "./schema.js";
import { adoptDesktopSessionAuthority } from "./session-authority.js";
import { SessionRecords } from "./session-records.js";
import { SqliteSessionRepository } from "./sqlite-session-repository.js";
test("session records list SQLite sessions and keep deleted ones out of the list", async () => {
  const db = new DatabaseSync(":memory:");
  const { initializeStateDatabase } = await import("./sqlite.js");
  initializeStateDatabase(db);
  const records = new SessionRecords(db, new SqliteSessionRepository(db));
  try {
    const first = await records.create(session("sess_first", "First"));
    await records.create(session("sess_second", "Second"));
    await records.update(first.id, { title: "First renamed", updatedAt: "2026-11-10T02:00:00.000Z" });

    assert.deepEqual((await records.listVisible()).map((item) => item.title), ["First renamed", "Second"]);
    assert.equal(await records.removeFromList(first.id), true);
    assert.equal(await records.get(first.id), null);
    assert.equal((await new SqliteSessionRepository(db).get(first.id))?.status, "archived");
    assert.deepEqual((await records.listVisible()).map((item) => item.id), ["sess_second"]);
  } finally {
    db.close();
  }
});

test("desktop JSON authority is applied once and preserves SQLite when the snapshot is empty", async () => {
  const db = new DatabaseSync(":memory:");
  const { initializeStateDatabase } = await import("./sqlite.js");
  initializeStateDatabase(db);
  const records = new SessionRecords(db, new SqliteSessionRepository(db));
  try {
    await records.create(session("sess_sqlite_only", "SQLite only"));
    adoptDesktopSessionAuthority(db, [{
      ...session("sess_json", "JSON title"),
      workspaceId: DEFAULT_WORKSPACE_ID,
      workspaceRoot: "G:/projects/json-workspace",
      llm: { provider: "deepseek", model: "deepseek-v4-flash" },
    }]);

    const visible = await records.listVisible();
    assert.deepEqual(visible.map((item) => item.id), ["sess_json"]);
    assert.equal(visible[0]?.workspaceRoot, "G:/projects/json-workspace");
    assert.equal(visible[0]?.llm?.model, "deepseek-v4-flash");

    adoptDesktopSessionAuthority(db, [session("sess_json", "Later JSON title")]);
    assert.equal((await records.get("sess_json"))?.title, "JSON title");

    const fresh = new DatabaseSync(":memory:");
    initializeStateDatabase(fresh);
    const freshRecords = new SessionRecords(fresh, new SqliteSessionRepository(fresh));
    try {
      await freshRecords.create(session("sess_keep", "Keep me"));
      adoptDesktopSessionAuthority(fresh, []);
      assert.equal((await freshRecords.listVisible()).length, 1);
    } finally {
      fresh.close();
    }
  } finally {
    db.close();
  }
});

function session(id: string, title: string) {
  return {
    id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    title,
    status: "active" as const,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T01:00:00.000Z",
    summary: null,
    workspaceRoot: "G:/projects/workspace",
    llm: null,
  };
}

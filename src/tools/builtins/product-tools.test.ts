import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Memory } from "../../core/types.js";
import type { MemoryRepository } from "../../state/repositories.js";
import { MemoryService } from "../../memory/service.js";
import { createCollectDiagnosticsTool } from "./collect-diagnostics.js";
import { parseGitHubRemote } from "./github-repo.js";
import { createForgetMemoryTool, createRememberFactTool, createSearchMemoryTool } from "./memory-tools.js";

class FakeMemoryRepository implements MemoryRepository {
  memories = new Map<string, Memory>();

  async create(memory: Memory): Promise<void> {
    this.memories.set(memory.id, memory);
  }

  async get(id: string): Promise<Memory | null> {
    return this.memories.get(id) ?? null;
  }

  async update(id: string, patch: Partial<Memory>): Promise<void> {
    const current = this.memories.get(id);
    if (current) this.memories.set(id, { ...current, ...patch, updatedAt: new Date() });
  }

  async delete(id: string): Promise<void> {
    this.memories.delete(id);
  }

  async search(scope: string, query: string, limit = 10): Promise<Memory[]> {
    const q = query.toLowerCase();
    return Array.from(this.memories.values())
      .filter((memory) => memory.scope === scope)
      .filter((memory) => !q || `${memory.summary} ${memory.content}`.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async listByWorkspace(workspaceScope: string, limit = 10): Promise<Memory[]> {
    return Array.from(this.memories.values())
      .filter((memory) => memory.workspaceScope === workspaceScope)
      .slice(0, limit);
  }
}

test("parseGitHubRemote supports HTTPS and SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/zaiyemeiyou404/shiguang-agent.git"), {
    owner: "zaiyemeiyou404",
    repo: "shiguang-agent",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:craft-ai-agents/craft-agents-oss.git"), {
    owner: "craft-ai-agents",
    repo: "craft-agents-oss",
  });
});

test("collect_diagnostics reports JSON parse errors without shelling out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shiguang-diag-"));
  try {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ nope", "utf8");
    const tool = createCollectDiagnosticsTool(dir);
    const output = await tool.execute({ path: "bad.json", mode: "json" }) as {
      ok: boolean;
      diagnostics: Array<{ message: string }>;
    };
    assert.equal(output.ok, false);
    assert.equal(output.diagnostics.length, 1);
    assert.match(output.diagnostics[0]?.message ?? "", /JSON|Expected|Unexpected/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory tools can remember, search, and forget a memory", async () => {
  const repo = new FakeMemoryRepository();
  const service = new MemoryService(repo);
  const remember = createRememberFactTool(service, "G:\\workspace");
  const search = createSearchMemoryTool(service, "G:\\workspace");
  const forget = createForgetMemoryTool(service);

  const saved = await remember.execute({
    summary: "Preferred workspace",
    content: "User wants Shiguang Agent data and tests on G:.",
    kind: "preference",
  }) as { memory: { id: string } };

  const found = await search.execute({ query: "Shiguang", scope: "workspace" }) as {
    memories: Array<{ id: string; summary: string }>;
  };
  assert.equal(found.memories.length, 1);
  assert.equal(found.memories[0]?.id, saved.memory.id);

  const deleted = await forget.execute({ id: saved.memory.id }) as { deleted: boolean };
  assert.equal(deleted.deleted, true);
  const afterDelete = await search.execute({ query: "Shiguang", scope: "workspace" }) as { memories: unknown[] };
  assert.equal(afterDelete.memories.length, 0);
});

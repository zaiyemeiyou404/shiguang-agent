import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Memory, MemoryCandidate } from "../../core/types.js";
import type { MemoryCandidateRepository, MemoryRepository } from "../../state/repositories.js";
import { MemoryService } from "../../memory/service.js";
import { MemoryCandidateService } from "../../memory/candidate-service.js";
import { createCollectDiagnosticsTool } from "./collect-diagnostics.js";
import { createCodeMapTool, createDependencyGraphTool, createSymbolSearchTool } from "./code-intelligence.js";
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

class FakeMemoryCandidateRepository implements MemoryCandidateRepository {
  candidates = new Map<string, MemoryCandidate>();
  async create(candidate: MemoryCandidate): Promise<void> { this.candidates.set(candidate.id, candidate); }
  async get(id: string): Promise<MemoryCandidate | null> { return this.candidates.get(id) ?? null; }
  async update(id: string, patch: Partial<MemoryCandidate>): Promise<void> {
    const current = this.candidates.get(id);
    if (current) this.candidates.set(id, { ...current, ...patch, updatedAt: new Date() });
  }
  async listPendingByWorkspace(workspaceScope: string, limit = 100): Promise<MemoryCandidate[]> {
    return Array.from(this.candidates.values()).filter((candidate) => candidate.workspaceScope === workspaceScope && candidate.status === "pending").slice(0, limit);
  }
}

function memoryCandidateService(memories = new FakeMemoryRepository(), candidates = new FakeMemoryCandidateRepository()) {
  return new MemoryCandidateService(candidates, new MemoryService(memories));
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

test("remember_fact creates a confirmation candidate before saving durable memory", async () => {
  const repo = new FakeMemoryRepository();
  const remember = createRememberFactTool(memoryCandidateService(repo), "G:\\workspace");

  const result = await remember.execute({
    summary: "Preferred workspace",
    content: "User wants Shiguang Agent data and tests on G:.",
    kind: "preference",
  }) as { candidate?: { status?: string; summary?: string } };

  assert.equal(result.candidate?.status, "pending");
  assert.equal(result.candidate?.summary, "Preferred workspace");
  assert.equal(repo.memories.size, 0);
});

test("accepting a workspace memory candidate is the only step that creates durable memory", async () => {
  const memories = new FakeMemoryRepository();
  const candidates = new FakeMemoryCandidateRepository();
  const service = new MemoryCandidateService(candidates, new MemoryService(memories));
  const candidate = await service.propose({
    scope: "workspace",
    workspaceScope: "G:\\workspace",
    kind: "decision",
    summary: "Use G drive",
    content: "Keep workspace data on G:.",
    salience: 0.8,
    sourceType: "task",
    sourceId: "test",
    confidence: 0.9,
  });

  assert.equal(memories.memories.size, 0);
  const memory = await service.accept(candidate.id, "G:\\workspace");
  assert.equal(memories.memories.get(memory.id)?.summary, "Use G drive");
  assert.deepEqual(await service.listPending("G:\\workspace"), []);
});

test("remember_fact refuses sensitive credentials and secrets", async () => {
  const repo = new FakeMemoryRepository();
  const remember = createRememberFactTool(memoryCandidateService(repo), "G:\\workspace");

  await assert.rejects(
    () => remember.execute({
      summary: "Production login",
      content: "password=correct-horse-battery-staple",
    }),
    /sensitive data/i,
  );
  assert.equal(repo.memories.size, 0);
});

test("remember_fact proposes memory without writing it directly", () => {
  const remember = createRememberFactTool(memoryCandidateService(), "G:\\workspace");

  assert.equal(remember.descriptor.requiresApproval, false);
  assert.equal(remember.descriptor.risk, "read");
});

test("memory tools keep workspace memories inside the active workspace", async () => {
  const repo = new FakeMemoryRepository();
  const service = new MemoryService(repo);
  const workspaceA = "G:\\workspace-a";
  const workspaceB = "G:\\workspace-b";
  const remember = createRememberFactTool(memoryCandidateService(repo), workspaceA);
  const search = createSearchMemoryTool(service, workspaceA);
  const forget = createForgetMemoryTool(service, workspaceA);

  const saved = await remember.execute({
    summary: "Workspace boundary",
    content: "This should remain in workspace A.",
    workspaceScope: workspaceB,
  }) as { candidate: { workspaceScope: string | null } };
  assert.equal(saved.candidate.workspaceScope, workspaceA);

  const now = new Date();
  await repo.create({
    id: "mem_workspace_b",
    scope: "workspace",
    workspaceScope: workspaceB,
    kind: "fact",
    summary: "Other workspace",
    content: "Must not be visible or removable from workspace A.",
    salience: 0.5,
    lastAccessedAt: null,
    sourceType: "user",
    sourceId: "test",
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
  });

  const found = await search.execute({ scope: "workspace", workspaceScope: workspaceB }) as {
    memories: Array<{ id: string }>;
  };
  assert.deepEqual(found.memories.map((memory) => memory.id), []);
  await assert.rejects(() => forget.execute({ id: "mem_workspace_b" }), /current workspace/i);
  assert.equal(repo.memories.has("mem_workspace_b"), true);
});

test("code intelligence tools map entrypoints, symbols, and dependencies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shiguang-code-map-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "sample-app",
      scripts: { dev: "vite --host 0.0.0.0" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { typescript: "^5.0.0", vite: "^6.0.0" },
    }), "utf8");
    writeFileSync(join(dir, "src", "main.ts"), [
      "import React from 'react';",
      "import { helper } from './util';",
      "export function bootstrap() { return helper(React.version); }",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "src", "util.ts"), [
      "export class Utility {}",
      "export const helper = (value: string) => value;",
    ].join("\n"), "utf8");

    const codeMap = await createCodeMapTool(dir).execute({ maxFiles: 20 }) as {
      entrypoints: string[];
      frameworks: string[];
      exportedSymbols: Array<{ name: string }>;
    };
    assert.deepEqual(codeMap.entrypoints, ["src/main.ts"]);
    assert.equal(codeMap.frameworks.includes("react"), true);
    assert.equal(codeMap.exportedSymbols.some((symbol) => symbol.name === "bootstrap"), true);

    const symbolSearch = await createSymbolSearchTool(dir).execute({ query: "Utility" }) as {
      results: Array<{ name: string; file: string }>;
    };
    assert.equal(symbolSearch.results[0]?.name, "Utility");
    assert.equal(symbolSearch.results[0]?.file, "src/util.ts");

    const graph = await createDependencyGraphTool(dir).execute({ maxFiles: 20 }) as {
      localEdges: Array<{ from: string; to: string }>;
      packageImports: Array<{ target: string; imports: number }>;
    };
    assert.equal(graph.localEdges.some((edge) => edge.from === "src/main.ts" && edge.to === "src/util"), true);
    assert.equal(graph.packageImports.some((edge) => edge.target === "react"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

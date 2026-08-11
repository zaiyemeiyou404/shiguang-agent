import type { Memory } from "../core/types.js";
import type { MemoryRepository } from "../state/repositories.js";
import type { MemoryQuery, MemoryStore, MemoryIndex } from "./types.js";
import { rankMemories } from "./ranker.js";

class InMemoryIndex implements MemoryIndex {
  private entries = new Map<string, Memory>();

  add(memory: Memory): void {
    this.entries.set(memory.id, memory);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  search(text: string, limit = 10): Memory[] {
    const q = text.trim().toLowerCase();
    const results: Array<{ mem: Memory; score: number }> = [];
    for (const mem of this.entries.values()) {
      const haystack = `${mem.summary} ${mem.content}`.toLowerCase();
      let score = mem.salience;
      if (q && haystack.includes(q)) score += 0.5;
      else {
        const words = q.split(/\s+/).filter(Boolean);
        const hits = words.filter(w => haystack.includes(w)).length;
        if (words.length > 0) score += (hits / words.length) * 0.4;
      }
      results.push({ mem, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map(r => r.mem);
  }
}

export class MemoryService implements MemoryStore {
  private index: MemoryIndex = new InMemoryIndex();

  constructor(private repo: MemoryRepository) {}

  async save(memory: Memory): Promise<void> {
    await this.repo.create(memory);
    this.index.add(memory);
  }

  async get(id: string): Promise<Memory | null> {
    return this.repo.get(id);
  }

  async search(query: MemoryQuery): Promise<Memory[]> {
    const scope = query.scope ?? (query.workspaceScope ? "workspace" : "global");
    const limit = query.limit ?? 10;
    const candidates = scope === "workspace" && query.workspaceScope
      ? await this.repo.listByWorkspace(query.workspaceScope, limit)
      : await this.repo.search(scope, query.text ?? "", limit);
    const results = candidates.filter(mem => {
      if (mem.scope !== scope) return false;
      if (query.kind && mem.kind !== query.kind) return false;
      if (scope === "workspace" && query.workspaceScope && mem.workspaceScope !== query.workspaceScope) {
        return false;
      }
      return true;
    });
    const ranked = rankMemories(results, query);

    const seenContent = new Set<string>();
    const deduped = ranked.filter(r => {
      const key = `${r.memory.summary}|${r.memory.content}`;
      if (seenContent.has(key)) return false;
      seenContent.add(key);
      return true;
    });

    return deduped
      .filter(r => r.relevance >= (query.minSalience ?? 0))
      .slice(0, limit)
      .map(r => r.memory);
  }

  async updateAccess(id: string): Promise<void> {
    const mem = await this.repo.get(id);
    if (mem) {
      const lastAccessedAt = new Date();
      await this.repo.update(id, { lastAccessedAt });
      this.index.add({ ...mem, lastAccessedAt });
    }
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
    this.index.remove(id);
  }

  searchLocal(text: string, limit = 10): Memory[] {
    return this.index.search(text, limit);
  }
}

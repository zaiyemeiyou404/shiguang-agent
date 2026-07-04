import type { Memory, MemoryKind, MemoryScope } from "../core/types.js";

export interface MemoryQuery {
  scope?: MemoryScope;
  workspaceScope?: string;
  kind?: MemoryKind;
  text?: string;
  limit?: number;
  minSalience?: number;
}

export interface MemoryRanking {
  memory: Memory;
  relevance: number;
  reason: string;
}

export interface MemoryStore {
  save(memory: Memory): Promise<void>;
  get(id: string): Promise<Memory | null>;
  search(query: MemoryQuery): Promise<Memory[]>;
  updateAccess(id: string): Promise<void>;
}

export interface MemoryIndex {
  add(memory: Memory): void;
  remove(id: string): void;
  search(text: string, limit?: number): Memory[];
}

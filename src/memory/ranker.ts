import type { Memory } from "../core/types.js";
import type { MemoryRanking, MemoryQuery } from "./types.js";

function textRelevance(query: string, memory: Memory): number {
  const q = query.trim().toLowerCase();
  const haystack = `${memory.summary} ${memory.content}`.toLowerCase();
  if (!q) return memory.salience;
  if (haystack.includes(q)) return 0.8 + (memory.salience * 0.2);
  const words = q.split(/\s+/).filter(Boolean);
  const hits = words.filter(w => haystack.includes(w)).length;
  if (words.length === 0) return memory.salience;
  return (hits / words.length) * 0.6 + memory.salience * 0.4;
}

export function rankMemories(
  memories: Memory[],
  query: MemoryQuery,
): MemoryRanking[] {
  const text = query.text ?? "";
  return memories
    .map(m => ({
      memory: m,
      relevance: textRelevance(text, m),
      reason: text ? `text match score ${textRelevance(text, m).toFixed(2)}` : `salience ${m.salience.toFixed(2)}`,
    }))
    .sort((a, b) => b.relevance - a.relevance);
}

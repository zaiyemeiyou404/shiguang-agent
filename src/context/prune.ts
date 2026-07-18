import type { ContextBundle, ContextItem } from "./types.js";

function normalizeContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function contentKey(item: ContextItem): string {
  return normalizeContent(item.content) || normalizeContent(item.source);
}

export function pruneContextBundle(bundle: ContextBundle): ContextBundle {
  const stable = [...bundle.stable];
  const volatile = pruneVolatile(bundle.volatile);
  const live = pruneLive(bundle.live);

  const all = [...stable, ...volatile, ...live];
  const totalBudget = all.reduce((s, i) => s + i.budget, 0);

  return { stable, volatile, live, totalBudget, builtAt: bundle.builtAt };
}

function pruneVolatile(items: ContextItem[]): ContextItem[] {
  const kept: ContextItem[] = [];
  const seenSources = new Set<string>();
  const seenRunKeys = new Set<string>();
  const runSummaryItems: ContextItem[] = [];
  const seenArtifactKeys = new Set<string>();
  const artifactItems: ContextItem[] = [];
  const seenMemoryKeys = new Set<string>();
  const memoryItems: ContextItem[] = [];

  for (const item of items) {
    if (item.kind === "user_turn") {
      kept.push(item);
      continue;
    }

    if (item.kind === "run_summary") {
      const key = `${normalizeContent(item.source)}:${contentKey(item)}`;
      if (!seenRunKeys.has(key)) {
        seenRunKeys.add(key);
        runSummaryItems.push(item);
      }
      continue;
    }

    if (item.kind === "artifact") {
      const key = contentKey(item);
      if (!seenArtifactKeys.has(key)) {
        seenArtifactKeys.add(key);
        artifactItems.push(item);
      }
      continue;
    }

    if (item.kind === "memory") {
      const key = contentKey(item);
      if (!seenMemoryKeys.has(key)) {
        seenMemoryKeys.add(key);
        memoryItems.push(item);
      }
      continue;
    }

    const sourceKey = normalizeContent(item.source);
    if (seenSources.has(sourceKey)) {
      continue;
    }
    seenSources.add(sourceKey);
    kept.push(item);
  }

  kept.push(...runSummaryItems);

  kept.push(...artifactItems);
  kept.push(...memoryItems);

  return kept;
}

function pruneLive(items: ContextItem[]): ContextItem[] {
  const seenSources = new Set<string>();
  const result: ContextItem[] = [];
  for (const item of items) {
    const key = normalizeContent(item.source);
    if (!seenSources.has(key)) {
      seenSources.add(key);
      result.push(item);
    }
  }
  return result;
}

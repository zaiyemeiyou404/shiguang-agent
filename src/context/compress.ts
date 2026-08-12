import type { ContextBundle, ContextItem, CompressionOptions } from "./types.js";
import { estimateTokens } from "./builder.js";

function normalizeContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function contentKey(item: ContextItem): string {
  return normalizeContent(item.content) || normalizeContent(item.source);
}

function oneLine(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function scoreLabel(item: ContextItem): string {
  return item.score.toFixed(2);
}

function metadataString(item: ContextItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function itemRecencyMs(item: ContextItem): number {
  return parseDateMs(metadataString(item, "endedAt"))
    ?? parseDateMs(metadataString(item, "startedAt"))
    ?? item.provenance.retrievedAt.getTime();
}

function runStatus(item: ContextItem): string {
  const metadataStatus = metadataString(item, "status");
  if (metadataStatus) return metadataStatus;
  const match = item.content.match(/^\[([^\]]+)\]/);
  return match?.[1] ?? "unknown";
}

function isHighSignalRun(item: ContextItem): boolean {
  const status = runStatus(item);
  return status === "failed"
    || status === "cancelled"
    || status === "needs_approval"
    || status === "paused"
    || item.score >= 0.8;
}

function runSummaryText(item: ContextItem): string {
  return oneLine(item.content.replace(/^\[[^\]]+\]\s*/, ""));
}

function runDateLabel(item: ContextItem): string {
  return metadataString(item, "endedAt")
    ?? metadataString(item, "startedAt")
    ?? item.provenance.retrievedAt.toISOString();
}

function byRecencyThenScore(a: ContextItem, b: ContextItem): number {
  return itemRecencyMs(b) - itemRecencyMs(a) || b.score - a.score;
}

function byRunDigestPriority(a: ContextItem, b: ContextItem): number {
  const signalDelta = Number(isHighSignalRun(b)) - Number(isHighSignalRun(a));
  return signalDelta || b.score - a.score || byRecencyThenScore(a, b);
}

function selectRunSummaries(runItems: ContextItem[], maxRun: number): {
  kept: ContextItem[];
  toDigest: ContextItem[];
} {
  if (maxRun <= 0) return { kept: [], toDigest: [...runItems].sort(byRunDigestPriority) };

  const kept: ContextItem[] = [];
  const newest = [...runItems].sort(byRecencyThenScore);
  const add = (item: ContextItem | undefined): void => {
    if (!item || kept.includes(item) || kept.length >= maxRun) return;
    kept.push(item);
  };

  add(newest[0]);

  const highSignal = [...runItems]
    .filter(isHighSignalRun)
    .sort((a, b) => b.score - a.score || byRecencyThenScore(a, b));
  for (const item of highSignal) add(item);
  for (const item of newest) add(item);

  const keptSet = new Set(kept);
  const toDigest = runItems.filter(i => !keptSet.has(i)).sort(byRunDigestPriority);
  return { kept, toDigest };
}

function makeDigest(
  kind: ContextItem["kind"],
  layer: ContextItem["layer"],
  source: string,
  content: string,
  avgScore: number,
): ContextItem {
  return {
    id: `digest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    layer,
    source,
    content,
    provenance: { source, retrievedAt: new Date(), method: "direct" },
    score: avgScore,
    budget: estimateTokens(content),
  };
}

function totalBudget(items: ContextItem[]): number {
  return items.reduce((sum, item) => sum + item.budget, 0);
}

function shouldReplaceWithDigest(items: ContextItem[], digest: ContextItem): boolean {
  return digest.budget < totalBudget(items);
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function formatDigestEntry(title: string, fields: Array<[string, string | undefined]>): string {
  const lines = [`- ${title}`];
  for (const [label, value] of fields) {
    if (value) lines.push(`  - ${label}: ${oneLine(value)}`);
  }
  return lines.join("\n");
}

function runDigestContent(items: ContextItem[]): string {
  const entries = items.map(i => formatDigestEntry(`Run: ${i.source}`, [
    ["Status", runStatus(i)],
    ["When", runDateLabel(i)],
    ["Score", scoreLabel(i)],
    ["Summary", runSummaryText(i)],
  ]));
  return ["Compressed run summaries:", ...entries].join("\n");
}

function memoryDigestContent(items: ContextItem[]): string {
  const entries = items.map(i => formatDigestEntry(`Memory: ${i.source}`, [
    ["Score", scoreLabel(i)],
    ["Retrieval", i.provenance.method],
    ["Summary", i.content],
  ]));
  return ["Compressed memories:", ...entries].join("\n");
}

function artifactDigestContent(items: ContextItem[]): string {
  const entries = items.map(i => formatDigestEntry(`Artifact: ${i.source}`, [
    ["Score", scoreLabel(i)],
    ["Link", i.provenance.method],
    ["Summary", i.content],
  ]));
  return ["Compressed artifacts:", ...entries].join("\n");
}

function rebuildBundle(
  bundle: ContextBundle,
  stable: ContextItem[],
  volatile: ContextItem[],
  live: ContextItem[],
): ContextBundle {
  const totalBudget = [...stable, ...volatile, ...live].reduce((s, i) => s + i.budget, 0);
  return { stable, volatile, live, totalBudget, builtAt: bundle.builtAt };
}

export function compressContextBundle(
  bundle: ContextBundle,
  options?: CompressionOptions,
): ContextBundle {
  const opts: CompressionOptions = {
    maxRunSummaryItems: normalizedLimit(options?.maxRunSummaryItems, 1),
    maxMemoryItems: normalizedLimit(options?.maxMemoryItems, 3),
    maxArtifactItems: normalizedLimit(options?.maxArtifactItems, 3),
  };

  const stable = [...bundle.stable];
  let volatile = [...bundle.volatile];
  const live = [...bundle.live];

  volatile = compressRunSummaries(volatile, opts);
  volatile = compressMemories(volatile, opts);
  volatile = compressArtifacts(volatile, opts);

  return rebuildBundle(bundle, stable, volatile, live);
}

function compressRunSummaries(
  items: ContextItem[],
  opts: CompressionOptions,
): ContextItem[] {
  const maxRun = opts.maxRunSummaryItems ?? 1;
  const runItems = items.filter(i => i.kind === "run_summary");
  const other = items.filter(i => i.kind !== "run_summary");

  if (runItems.length <= maxRun) return items;

  const { kept, toDigest } = selectRunSummaries(runItems, maxRun);

  if (toDigest.length === 0) return [...other, ...kept];

  const avgScore = toDigest.reduce((s, i) => s + i.score, 0) / toDigest.length;
  const digest = makeDigest(
    "run_digest",
    "volatile",
    "compress:run_summaries",
    runDigestContent(toDigest),
    avgScore,
  );

  if (!shouldReplaceWithDigest(toDigest, digest)) {
    return [...other, ...runItems];
  }

  return [...other, ...kept, digest];
}

function compressMemories(
  items: ContextItem[],
  opts: CompressionOptions,
): ContextItem[] {
  const maxMem = opts.maxMemoryItems ?? 3;
  const memoryItems = items.filter(i => i.kind === "memory");
  const other = items.filter(i => i.kind !== "memory");

  if (memoryItems.length <= maxMem) return items;

  memoryItems.sort((a, b) => b.score - a.score);
  const kept = memoryItems.slice(0, maxMem);
  const toDigest = memoryItems.slice(maxMem);

  if (toDigest.length === 0) return [...other, ...kept];

  const seen = new Set<string>();
  const uniqueDigest = toDigest.filter(i => {
    const key = contentKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const avgScore = toDigest.reduce((s, i) => s + i.score, 0) / toDigest.length;
  const digest = makeDigest(
    "memory_digest",
    "volatile",
    "compress:memories",
    memoryDigestContent(uniqueDigest),
    avgScore,
  );

  if (!shouldReplaceWithDigest(toDigest, digest)) {
    return [...other, ...memoryItems];
  }

  return [...other, ...kept, digest];
}

function compressArtifacts(
  items: ContextItem[],
  opts: CompressionOptions,
): ContextItem[] {
  const maxArt = opts.maxArtifactItems ?? 3;
  const artItems = items.filter(i => i.kind === "artifact");
  const other = items.filter(i => i.kind !== "artifact");

  if (artItems.length <= maxArt) return items;

  const seen = new Set<string>();
  const uniqueArts = artItems.filter(i => {
    const key = contentKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueArts.length <= maxArt) return [...other, ...uniqueArts];

  uniqueArts.sort((a, b) => b.score - a.score);
  const kept = uniqueArts.slice(0, maxArt);
  const toDigest = uniqueArts.slice(maxArt);

  if (toDigest.length === 0) return [...other, ...kept];

  const avgScore = toDigest.reduce((s, i) => s + i.score, 0) / toDigest.length;
  const digest = makeDigest(
    "artifact_digest",
    "volatile",
    "compress:artifacts",
    artifactDigestContent(toDigest),
    avgScore,
  );

  if (!shouldReplaceWithDigest(toDigest, digest)) {
    return [...other, ...uniqueArts];
  }

  return [...other, ...kept, digest];
}

export type { CompressionOptions };

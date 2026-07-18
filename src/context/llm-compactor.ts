import type { ContextBundle, ContextItem } from "./types.js";

export interface ContextCompactionPressure {
  budgetExcess: number;
  volatileItemCount: number;
  duplicateRatio: number;
}

export interface LlmCompactorInput {
  bundle: ContextBundle;
  maxBudget: number;
  pressure: ContextCompactionPressure;
}

export interface LlmCompactor {
  readonly name: string;
  compact(input: LlmCompactorInput): Promise<ContextBundle>;
}

function normalizeContent(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function duplicateKey(item: ContextItem): string {
  const content = normalizeContent(item.content);
  return `${item.kind}:${content || normalizeContent(item.source)}`;
}

function computeDuplicateRatio(items: ContextItem[]): number {
  if (items.length === 0) return 0;

  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const item of items) {
    const key = duplicateKey(item);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
  }

  return duplicateCount / items.length;
}

export function computeCompactionPressure(
  bundle: ContextBundle,
  maxBudget: number,
): ContextCompactionPressure {
  const volatileItems = bundle.volatile.length;
  const allItems = [...bundle.stable, ...bundle.volatile, ...bundle.live];
  const budgetExcess = Math.max(0, bundle.totalBudget - Math.max(0, maxBudget));
  const duplicateRatio = computeDuplicateRatio(allItems);

  return { budgetExcess, volatileItemCount: volatileItems, duplicateRatio };
}

export function shouldUseLlmCompaction(
  bundle: ContextBundle,
  maxBudget: number,
  pressure = computeCompactionPressure(bundle, maxBudget),
): boolean {
  if (pressure.budgetExcess === 0 || pressure.volatileItemCount <= 10) {
    return false;
  }

  const excessRatio = maxBudget > 0 ? pressure.budgetExcess / maxBudget : 1;
  return pressure.budgetExcess > 1024 || excessRatio > 0.15 || pressure.duplicateRatio > 0.2;
}

export class NoopLlmCompactor implements LlmCompactor {
  readonly name = "noop";

  async compact(input: LlmCompactorInput): Promise<ContextBundle> {
    return input.bundle;
  }
}

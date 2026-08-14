export interface LlmTokenUsage {
  provider: string;
  model: string;
  requestCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  promptEstimateTokens?: number;
  selectedToolSchemaCount?: number;
  totalToolSchemaCount?: number;
  mode?: string;
}

export interface RunTokenUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  promptEstimateTokens: number;
}

export function emptyRunTokenUsage(): RunTokenUsage {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    promptEstimateTokens: 0,
  };
}

export function mergeLlmTokenUsage(...items: Array<LlmTokenUsage | undefined>): LlmTokenUsage | undefined {
  const present = items.filter((item): item is LlmTokenUsage => Boolean(item));
  if (present.length === 0) return undefined;

  const first = present[0]!;
  const merged: LlmTokenUsage = {
    provider: first.provider,
    model: first.model,
    requestCount: sumNumbers(present.map((item) => item.requestCount)),
  };

  addOptionalSum(merged, "inputTokens", present);
  addOptionalSum(merged, "outputTokens", present);
  addOptionalSum(merged, "totalTokens", present);
  addOptionalSum(merged, "cachedInputTokens", present);
  addOptionalSum(merged, "reasoningTokens", present);
  addOptionalSum(merged, "promptEstimateTokens", present);

  const last = present[present.length - 1]!;
  if (typeof last.selectedToolSchemaCount === "number") {
    merged.selectedToolSchemaCount = last.selectedToolSchemaCount;
  }
  if (typeof last.totalToolSchemaCount === "number") {
    merged.totalToolSchemaCount = last.totalToolSchemaCount;
  }
  if (last.mode) merged.mode = last.mode;

  return merged;
}

export function addUsageToRunUsage(total: RunTokenUsage, usage: LlmTokenUsage): RunTokenUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? (inputTokens + outputTokens);

  return {
    requestCount: total.requestCount + Math.max(usage.requestCount, 1),
    inputTokens: total.inputTokens + inputTokens,
    outputTokens: total.outputTokens + outputTokens,
    totalTokens: total.totalTokens + totalTokens,
    cachedInputTokens: total.cachedInputTokens + (usage.cachedInputTokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
    promptEstimateTokens: total.promptEstimateTokens + (usage.promptEstimateTokens ?? 0),
  };
}

export function estimateMessagesTokens(messages: Array<{ content: string }>, extra = ""): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, extra.length);
  return Math.ceil(chars / 4);
}

function addOptionalSum(
  merged: LlmTokenUsage,
  key: keyof Pick<LlmTokenUsage, "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens" | "reasoningTokens" | "promptEstimateTokens">,
  items: LlmTokenUsage[],
): void {
  const values = items
    .map((item) => item[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return;
  merged[key] = sumNumbers(values);
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

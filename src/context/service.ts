import type { ContextBundle, RenderedPrompt, CompressionStats } from "./types.js";
import { buildContext, trimToBudget, type ContextBuilderInput } from "./builder.js";

export type { ContextBuilderInput };
import { renderPrompt } from "./render.js";
import type { MemoryService } from "../memory/service.js";
import { pruneContextBundle } from "./prune.js";
import { compressContextBundle, type CompressionOptions } from "./compress.js";
import {
  computeCompactionPressure,
  shouldUseLlmCompaction,
  type ContextCompactionPressure,
  type LlmCompactor,
} from "./llm-compactor.js";

const DEFAULT_MIN_COMPRESSION_BUDGET_PRESSURE = 0.75;

export interface ContextServiceOptions {
  memoryService?: MemoryService;
  workspaceRoot?: string;
  maxBudget?: number;
  compressionOptions?: CompressionOptions;
  llmCompactor?: LlmCompactor;
}

export interface ContextBuildDiagnostics {
  compression: CompressionStats;
  usedLlmCompactor: boolean;
}

export class ContextService {
  private memoryService?: MemoryService;
  private workspaceRoot?: string;
  private maxBudget: number;
  private compressionOptions?: CompressionOptions;
  private llmCompactor?: LlmCompactor;

  constructor(opts: ContextServiceOptions = {}) {
    this.memoryService = opts.memoryService;
    this.workspaceRoot = opts.workspaceRoot;
    this.maxBudget = opts.maxBudget ?? 8192;
    this.compressionOptions = opts.compressionOptions;
    this.llmCompactor = opts.llmCompactor;
  }

  async build(input: ContextBuilderInput): Promise<{
    bundle: ContextBundle;
    diagnostics: ContextBuildDiagnostics;
  }> {
    const memories: ContextBuilderInput["memories"] = [...input.memories];
    const enrichedInput: ContextBuilderInput = {
      ...input,
      memories,
      workspaceRoot: input.workspaceRoot ?? this.workspaceRoot,
    };

    if (this.memoryService) {
      const workspaceScope = enrichedInput.workspaceRoot ?? input.task.sessionId;
      const foundMemories = await this.memoryService.search({
        scope: enrichedInput.workspaceRoot ? "workspace" : "task",
        workspaceScope,
        text: input.userTurn,
        limit: 8,
      });
      const existingIds = new Set(enrichedInput.memories.map(m => m.id));
      for (const mem of foundMemories) {
        if (!existingIds.has(mem.id)) {
          enrichedInput.memories.push({
            id: mem.id,
            content: mem.content,
            summary: mem.summary,
            confidence: mem.confidence,
          });
        }
      }
    }

    const initialBundle = buildContext(enrichedInput);
    const originalItems = [...initialBundle.stable, ...initialBundle.volatile, ...initialBundle.live];

    let bundle = pruneContextBundle(initialBundle);
    const prunedItems = [...bundle.stable, ...bundle.volatile, ...bundle.live];
    const deterministicCompressionTriggered = shouldUseDeterministicCompression(
      bundle,
      this.maxBudget,
      this.compressionOptions,
    );
    if (deterministicCompressionTriggered) {
      bundle = compressContextBundle(bundle, this.compressionOptions);
    }
    const compressedItems = [...bundle.stable, ...bundle.volatile, ...bundle.live];

    const pressure = computeCompactionPressure(bundle, this.maxBudget);
    let usedLlmCompactor = false;
    if (this.llmCompactor && shouldUseLlmCompaction(bundle, this.maxBudget, pressure)) {
      bundle = await this.llmCompactor.compact({
        bundle,
        maxBudget: this.maxBudget,
        pressure,
      });
      usedLlmCompactor = true;
    }

    const finalBundle = trimToBudget(bundle, this.maxBudget);
    return {
      bundle: finalBundle,
      diagnostics: {
        compression: {
          originalItemCount: originalItems.length,
          originalBudget: initialBundle.totalBudget,
          prunedCount: Math.max(0, originalItems.length - prunedItems.length),
          compressedCount: Math.max(0, prunedItems.length - compressedItems.length),
          finalBudget: finalBundle.totalBudget,
          compressionTriggered: deterministicCompressionTriggered || usedLlmCompactor,
          budgetPressure: this.maxBudget > 0 ? initialBundle.totalBudget / this.maxBudget : 1,
          maxBudget: this.maxBudget,
        },
        usedLlmCompactor,
      },
    };
  }

  render(bundle: ContextBundle): RenderedPrompt {
    return renderPrompt(bundle);
  }

  async buildAndRender(input: ContextBuilderInput): Promise<{
    bundle: ContextBundle;
    prompt: RenderedPrompt;
    diagnostics: ContextBuildDiagnostics;
  }> {
    const { bundle, diagnostics } = await this.build(input);
    const prompt = this.render(bundle);
    return { bundle, prompt, diagnostics };
  }
}

function shouldUseDeterministicCompression(
  bundle: ContextBundle,
  maxBudget: number,
  options?: CompressionOptions,
  pressure: ContextCompactionPressure = computeCompactionPressure(bundle, maxBudget),
): boolean {
  if (pressure.budgetExcess > 0) return true;
  const threshold = normalizeCompressionThreshold(options?.minBudgetPressure);
  const budgetPressure = maxBudget > 0 ? bundle.totalBudget / maxBudget : 1;
  return budgetPressure >= threshold;
}

function normalizeCompressionThreshold(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_COMPRESSION_BUDGET_PRESSURE;
  return Math.min(1, Math.max(0, value ?? DEFAULT_MIN_COMPRESSION_BUDGET_PRESSURE));
}

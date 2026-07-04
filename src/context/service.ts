import type { ContextBundle, RenderedPrompt } from "./types.js";
import { buildContext, trimToBudget, type ContextBuilderInput } from "./builder.js";

export type { ContextBuilderInput };
import { renderPrompt } from "./render.js";
import type { MemoryService } from "../memory/service.js";
import { pruneContextBundle } from "./prune.js";
import { compressContextBundle, type CompressionOptions } from "./compress.js";
import {
  computeCompactionPressure,
  shouldUseLlmCompaction,
  type LlmCompactor,
} from "./llm-compactor.js";

export interface ContextServiceOptions {
  memoryService?: MemoryService;
  workspaceRoot?: string;
  maxBudget?: number;
  compressionOptions?: CompressionOptions;
  llmCompactor?: LlmCompactor;
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

  async build(input: ContextBuilderInput): Promise<ContextBundle> {
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

    let bundle = buildContext(enrichedInput);
    bundle = pruneContextBundle(bundle);
    bundle = compressContextBundle(bundle, this.compressionOptions);

    const pressure = computeCompactionPressure(bundle, this.maxBudget);
    if (this.llmCompactor && shouldUseLlmCompaction(bundle, this.maxBudget, pressure)) {
      bundle = await this.llmCompactor.compact({
        bundle,
        maxBudget: this.maxBudget,
        pressure,
      });
    }

    return trimToBudget(bundle, this.maxBudget);
  }

  render(bundle: ContextBundle): RenderedPrompt {
    return renderPrompt(bundle);
  }

  async buildAndRender(input: ContextBuilderInput): Promise<{
    bundle: ContextBundle;
    prompt: RenderedPrompt;
  }> {
    const bundle = await this.build(input);
    const prompt = this.render(bundle);
    return { bundle, prompt };
  }
}

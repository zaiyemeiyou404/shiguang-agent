import { ContextService } from "../context/service.js";
import type { ContextBuildDiagnostics } from "../context/service.js";
import type { ContextBuilderInput } from "../context/builder.js";
import type { Turn } from "../core/types.js";
import { RulePlanner, type Planner } from "../brain/planner.js";
import { ToolMetadataPolicy, type Policy } from "../brain/policy.js";
import { BasicEvaluator } from "../brain/evaluator.js";
import type { BrainDecision } from "../brain/types.js";
import { applyActionResultToWorkingMemory, runLoop, type LoopState } from "../brain/loop.js";
import { ActionDispatcher } from "../runtime/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { echoTool } from "../tools/builtins/echo.js";
import type { EventSink } from "../runtime/event-sink.js";
import type { TurnRepository } from "../state/repositories.js";
import type { MemoryService } from "../memory/service.js";
import { randomUUID } from "node:crypto";

export interface AgentOptions {
  eventSink: EventSink;
  turnRepository?: TurnRepository;
  recentTurnLimit?: number;
  planner?: Planner;
  tools?: Tool[];
  memoryService?: MemoryService;
  workspaceRoot?: string;
}

export interface AgentInput {
  runId: string;
  userMessage: string;
  contextInput: Omit<ContextBuilderInput, "userTurn">;
  signal?: AbortSignal;
}

export interface AgentOutput {
  state: LoopState;
}

export interface AgentApprovalResumeInput {
  runId: string;
  userMessage: string;
  signal?: AbortSignal;
  approvedAction: {
    toolName: string;
    toolInput?: unknown;
  };
  contextInput: Omit<ContextBuilderInput, "userTurn">;
}

export class Agent {
  private toolRegistry: ToolRegistry;
  private planner: Planner;
  private policy: Policy;
  private evaluator: BasicEvaluator;
  private dispatcher: ActionDispatcher;
  private contextService: ContextService;

  constructor(private options: AgentOptions) {
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.register(echoTool);
    if (options.tools) {
      for (const tool of options.tools) {
        this.toolRegistry.register(tool);
      }
    }

    this.planner = options.planner ?? new RulePlanner();
    this.policy = new ToolMetadataPolicy(this.toolRegistry.all());
    this.evaluator = new BasicEvaluator();
    this.dispatcher = new ActionDispatcher(this.toolRegistry, options.eventSink);
    this.contextService = new ContextService({
      memoryService: options.memoryService,
      workspaceRoot: options.workspaceRoot,
    });
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const sessionId = input.contextInput.task.sessionId;
    const priorTurns = await this.loadPriorTurns(sessionId);
    await this.persistCurrentTurns(input, priorTurns);

    try {
      const { bundle, diagnostics } = await this.contextService.buildAndRender({
        userTurn: input.userMessage,
        ...input.contextInput,
      });
      await this.emitContextCompactionEvent(input.runId, diagnostics);

      const brainInput = {
        context: bundle,
        runId: input.runId,
        priorTurns,
        history: [],
        availableTools: this.toolRegistry.all(),
      };

      const state = await runLoop(
        brainInput,
        {
          planner: this.planner,
          policy: this.policy,
          dispatcher: {
            dispatch: (decision, context) => this.dispatcher.dispatch(decision, input.runId, context),
          },
          evaluator: this.evaluator,
        },
        12,
        { signal: input.signal },
      );

      await this.persistAssistantTurn(sessionId, summarizeAssistantTurn(state));
      return { state };
    } catch (error) {
      await this.persistAssistantTurn(sessionId, summarizeFailureTurn(error));
      throw error;
    }
  }

  async resumeAfterApproval(input: AgentApprovalResumeInput): Promise<AgentOutput> {
    const sessionId = input.contextInput.task.sessionId;
    const priorTurns = await this.loadPriorTurns(sessionId);

    try {
      const { bundle, diagnostics } = await this.contextService.buildAndRender({
        userTurn: input.userMessage,
        ...input.contextInput,
      });
      await this.emitContextCompactionEvent(input.runId, diagnostics);

      const approvedDecision: BrainDecision = {
        action: {
          kind: "tool_call",
          toolName: input.approvedAction.toolName,
          toolInput: input.approvedAction.toolInput,
        },
        reasoning: `Resuming approved tool: ${input.approvedAction.toolName}`,
      };

      const approvedResult = await this.dispatcher.dispatch(approvedDecision, input.runId, { signal: input.signal });
      const initialHistory = [approvedResult];
      const initialWorkingMemory = applyActionResultToWorkingMemory(
        { step: 0, lastActionKind: null },
        1,
        approvedResult,
      );
      const initialAction = await this.evaluator.evaluate(approvedDecision, approvedResult, initialHistory);

      let state: LoopState;
      if (initialAction.kind === "stop") {
        state = {
          steps: 1,
          history: initialHistory,
          workingMemory: initialWorkingMemory,
          lastDecision: approvedDecision,
          lastResult: approvedResult,
          stopReason: initialAction.reason,
          stopSummary: initialAction.summary ?? null,
        };
      } else {
        const brainInput = {
          context: bundle,
          runId: input.runId,
          priorTurns,
          history: initialHistory,
          workingMemory: initialWorkingMemory,
          availableTools: this.toolRegistry.all(),
        };

        state = await runLoop(
          brainInput,
          {
            planner: this.planner,
            policy: this.policy,
            dispatcher: {
              dispatch: (decision, context) => this.dispatcher.dispatch(decision, input.runId, context),
            },
            evaluator: this.evaluator,
          },
          12,
          { signal: input.signal },
        );
      }

      await this.persistAssistantTurn(sessionId, summarizeAssistantTurn(state));
      return { state };
    } catch (error) {
      await this.persistAssistantTurn(sessionId, summarizeFailureTurn(error));
      throw error;
    }
  }

  private async loadPriorTurns(sessionId: string): Promise<Turn[]> {
    if (!this.options.turnRepository) return [];
    return this.options.turnRepository.listBySession(sessionId, this.options.recentTurnLimit ?? 20);
  }

  private async persistCurrentTurns(input: AgentInput, priorTurns: Turn[]): Promise<void> {
    if (!this.options.turnRepository) return;

    const sessionId = input.contextInput.task.sessionId;
    const systemInstructions = input.contextInput.systemInstructions?.trim();
    if (systemInstructions && shouldPersistSystemTurn(priorTurns, systemInstructions)) {
      await this.options.turnRepository.create(makeTurn(sessionId, "system", systemInstructions));
    }

    await this.options.turnRepository.create(makeTurn(sessionId, "user", input.userMessage));
  }

  private async persistAssistantTurn(sessionId: string, content: string): Promise<void> {
    if (!this.options.turnRepository) return;
    await this.options.turnRepository.create(makeTurn(sessionId, "assistant", content));
  }

  private async emitContextCompactionEvent(runId: string, diagnostics: ContextBuildDiagnostics): Promise<void> {
    const { compression, usedLlmCompactor } = diagnostics;
    const changed = compression.finalBudget < compression.originalBudget;
    if (!changed || !this.options.eventSink) return;

    const finalItemEstimate = Math.max(
      0,
      compression.originalItemCount - compression.prunedCount - compression.compressedCount,
    );
    await this.options.eventSink.record(runId, "context_compacted", {
      message: `上下文已压缩，估算 token 约从 ${compression.originalBudget} 降到 ${compression.finalBudget}。`,
      originalItemCount: compression.originalItemCount,
      prunedCount: compression.prunedCount,
      compressedCount: compression.compressedCount,
      finalItemEstimate,
      originalBudget: compression.originalBudget,
      finalBudget: compression.finalBudget,
      usedLlmCompactor,
    });
  }
}

function makeTurn(sessionId: string, role: Turn["role"], content: string): Turn {
  return {
    id: randomUUID(),
    sessionId,
    role,
    content,
    createdAt: new Date(),
  };
}

function shouldPersistSystemTurn(priorTurns: Turn[], content: string): boolean {
  const lastSystemTurn = [...priorTurns].reverse().find(turn => turn.role === "system");
  return lastSystemTurn?.content !== content;
}

function summarizeAssistantTurn(state: LoopState): string {
  const action = state.lastDecision?.action;
  if (!action) return "Run completed without an assistant action.";

  if (action.kind === "respond") {
    return action.content ?? "Run completed.";
  }

  if (action.kind === "finish") {
    return action.content ?? "Done.";
  }

  if (action.kind === "fail") {
    return action.reason ?? "Run failed.";
  }

  if (action.kind === "needs_approval") {
    return action.reason ?? `Run needs approval for ${action.toolName ?? "a tool"}.`;
  }

  if (state.stopReason) {
    return state.stopSummary
      ? `Run stopped: ${state.stopReason}: ${state.stopSummary}`
      : `Run stopped: ${state.stopReason}.`;
  }

  return `Run stopped after ${state.steps} steps.`;
}

function summarizeFailureTurn(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Run failed before completion: ${message}`;
}

export { ToolRegistry };

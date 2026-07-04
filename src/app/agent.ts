import { ContextService } from "../context/service.js";
import type { ContextBuilderInput } from "../context/builder.js";
import type { Turn } from "../core/types.js";
import { RulePlanner, type Planner } from "../brain/planner.js";
import { AllowAllPolicy } from "../brain/policy.js";
import { BasicEvaluator } from "../brain/evaluator.js";
import { runLoop, type LoopState } from "../brain/loop.js";
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
}

export interface AgentOutput {
  state: LoopState;
}

export class Agent {
  private toolRegistry: ToolRegistry;
  private planner: Planner;
  private policy: AllowAllPolicy;
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
    this.policy = new AllowAllPolicy();
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
      const { bundle } = await this.contextService.buildAndRender({
        userTurn: input.userMessage,
        ...input.contextInput,
      });

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
            dispatch: (decision) => this.dispatcher.dispatch(decision, input.runId),
          },
          evaluator: this.evaluator,
        },
      );

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

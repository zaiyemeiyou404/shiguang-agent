import { buildContext, type ContextBuilderInput } from "../context/builder.js";
import { RulePlanner, type Planner } from "../brain/planner.js";
import { AllowAllPolicy } from "../brain/policy.js";
import { BasicEvaluator } from "../brain/evaluator.js";
import { runLoop, type LoopState } from "../brain/loop.js";
import { ActionDispatcher } from "../runtime/dispatcher.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { echoTool } from "../tools/builtins/echo.js";
import type { EventSink } from "../runtime/event-sink.js";
import type { InMemoryRunStore } from "../state/run-store.js";

export interface AgentOptions {
  eventSink: EventSink;
  runStore: InMemoryRunStore;
  planner?: Planner;
  tools?: Tool[];
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
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const context = buildContext({
      userTurn: input.userMessage,
      ...input.contextInput,
    });

    const brainInput = {
      context,
      runId: input.runId,
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

    return { state };
  }
}

export { ToolRegistry };

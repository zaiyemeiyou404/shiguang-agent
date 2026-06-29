import type { BrainInput, BrainDecision, ActionResult } from "./types.js";
import type { Planner } from "./planner.js";
import type { Policy } from "./policy.js";
import type { Evaluator, LoopAction } from "./evaluator.js";

export interface LoopDeps {
  planner: Planner;
  policy: Policy;
  dispatcher: {
    dispatch(decision: BrainDecision): Promise<ActionResult>;
  };
  evaluator: Evaluator;
}

export interface LoopState {
  steps: number;
  history: ActionResult[];
  lastDecision: BrainDecision | null;
  lastResult: ActionResult | null;
}

export async function runLoop(
  input: BrainInput,
  deps: LoopDeps,
  maxSteps = 10,
): Promise<LoopState> {
  const state: LoopState = { steps: 0, history: [], lastDecision: null, lastResult: null };

  for (let i = 0; i < maxSteps; i++) {
    state.steps++;

    const decision = await deps.planner.decide(input);
    const approved = await deps.policy.check(decision);
    state.lastDecision = approved;

    const result = await deps.dispatcher.dispatch(approved);
    state.lastResult = result;
    state.history.push(result);

    const action: LoopAction = await deps.evaluator.evaluate(approved, result);
    if (action === "stop") break;

    input = { ...input, history: state.history };
  }

  return state;
}

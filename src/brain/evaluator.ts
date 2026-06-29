import type { BrainDecision, ActionResult } from "./types.js";

export type LoopAction = "continue" | "stop";

export interface Evaluator {
  evaluate(decision: BrainDecision, result?: ActionResult): Promise<LoopAction>;
}

export class BasicEvaluator implements Evaluator {
  async evaluate(decision: BrainDecision, _result?: ActionResult): Promise<LoopAction> {
    if (decision.action.kind === "finish" || decision.action.kind === "fail") {
      return "stop";
    }
    return "continue";
  }
}

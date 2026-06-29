import type { BrainDecision } from "./types.js";

export interface Policy {
  check(decision: BrainDecision): Promise<BrainDecision>;
}

export class AllowAllPolicy implements Policy {
  async check(decision: BrainDecision): Promise<BrainDecision> {
    return decision;
  }
}

import type { Run } from "../core/types.js";

export class InMemoryRunStore {
  private runs = new Map<string, Run>();

  save(run: Run): void {
    this.runs.set(run.id, run);
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  list(): Run[] {
    return Array.from(this.runs.values());
  }
}

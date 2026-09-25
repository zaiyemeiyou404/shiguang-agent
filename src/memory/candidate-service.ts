import { randomUUID } from "node:crypto";
import type { Memory, MemoryCandidate, MemoryKind, MemoryScope } from "../core/types.js";
import type { MemoryCandidateRepository } from "../state/repositories.js";
import type { MemoryService } from "./service.js";

export type MemoryCandidateInput = Pick<MemoryCandidate, "scope" | "workspaceScope" | "kind" | "summary" | "content" | "salience" | "sourceType" | "sourceId" | "confidence">;

export class MemoryCandidateService {
  constructor(private candidates: MemoryCandidateRepository, private memories: MemoryService) {}
  async propose(input: MemoryCandidateInput): Promise<MemoryCandidate> {
    const now = new Date();
    const candidate: MemoryCandidate = { id: `mem_candidate_${randomUUID()}`, ...input, status: "pending", createdAt: now, updatedAt: now, resolvedAt: null };
    await this.candidates.create(candidate);
    return candidate;
  }
  async listPending(workspaceScope: string): Promise<MemoryCandidate[]> { return this.candidates.listPendingByWorkspace(workspaceScope); }
  async accept(id: string, workspaceScope: string): Promise<Memory> {
    const candidate = await this.requirePending(id, workspaceScope);
    const now = new Date();
    const memory: Memory = { id: `mem_${randomUUID()}`, scope: candidate.scope, workspaceScope: candidate.workspaceScope, kind: candidate.kind, summary: candidate.summary, content: candidate.content, salience: candidate.salience, lastAccessedAt: null, sourceType: candidate.sourceType, sourceId: candidate.sourceId, confidence: candidate.confidence, createdAt: now, updatedAt: now };
    await this.memories.save(memory);
    await this.candidates.update(candidate.id, { status: "accepted", resolvedAt: now });
    return memory;
  }
  async dismiss(id: string, workspaceScope: string): Promise<void> { const candidate = await this.requirePending(id, workspaceScope); await this.candidates.update(candidate.id, { status: "dismissed", resolvedAt: new Date() }); }
  private async requirePending(id: string, workspaceScope: string): Promise<MemoryCandidate> { const candidate = await this.candidates.get(id); if (!candidate || candidate.workspaceScope !== workspaceScope || candidate.status !== "pending") throw new Error("Memory candidate does not belong to the current workspace."); return candidate; }
}

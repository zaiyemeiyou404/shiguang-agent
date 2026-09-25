import type { Memory, MemoryKind, MemoryScope } from "../../core/types.js";
import type { MemoryCandidateService } from "../../memory/candidate-service.js";
import type { MemoryService } from "../../memory/service.js";
import type { Tool, ToolApprovalPreview } from "../types.js";

type MemoryToolScope = MemoryScope;
type MemoryToolKind = MemoryKind;

function isScope(value: unknown): value is MemoryToolScope {
  return value === "session" || value === "task" || value === "global" || value === "workspace";
}

function isKind(value: unknown): value is MemoryToolKind {
  return value === "fact"
    || value === "insight"
    || value === "preference"
    || value === "observation"
    || value === "decision";
}

function normalizeLimit(value: unknown): number {
  return Math.max(1, Math.min(50, Math.trunc(typeof value === "number" ? value : 10)));
}

const SENSITIVE_MEMORY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|set-cookie)\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

function assertSafeMemoryText(summary: string, content: string): void {
  const text = `${summary}\n${content}`;
  if (SENSITIVE_MEMORY_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("remember_fact: sensitive data cannot be saved to memory");
  }
}

function serializeMemory(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    scope: memory.scope,
    workspaceScope: memory.workspaceScope,
    kind: memory.kind,
    summary: memory.summary,
    content: memory.content,
    salience: memory.salience,
    confidence: memory.confidence,
    sourceType: memory.sourceType,
    sourceId: memory.sourceId,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

export function createSearchMemoryTool(memoryService: MemoryService, workspaceRoot?: string): Tool {
  return {
    descriptor: {
      name: "search_memory",
      description: "Search saved Shiguang memories. Accepts { query?, scope?, workspaceScope?, kind?, limit? }.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["session", "task", "global", "workspace"] },
          workspaceScope: { type: "string" },
          kind: { type: "string", enum: ["fact", "insight", "preference", "observation", "decision"] },
          limit: { type: "number" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "memory.read",
    },
    async execute(input: unknown): Promise<unknown> {
      const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const scope = isScope(obj.scope) ? obj.scope : (obj.workspaceScope || workspaceRoot ? "workspace" : "global");
      const workspaceScope = workspaceRoot ?? (typeof obj.workspaceScope === "string" ? obj.workspaceScope : undefined);
      const memories = await memoryService.search({
        text: typeof obj.query === "string" ? obj.query : "",
        scope,
        ...(workspaceScope ? { workspaceScope } : {}),
        ...(isKind(obj.kind) ? { kind: obj.kind } : {}),
        limit: normalizeLimit(obj.limit),
      });
      return { memories: memories.map(serializeMemory) };
    },
  };
}

export function createRememberFactTool(memoryCandidates: MemoryCandidateService, workspaceRoot?: string): Tool {
  return {
    descriptor: {
      name: "remember_fact",
      description: "Propose a durable memory for user confirmation. Accepts { summary, content, scope?, workspaceScope?, kind?, salience?, confidence? }.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          content: { type: "string" },
          scope: { type: "string", enum: ["session", "task", "global", "workspace"] },
          workspaceScope: { type: "string" },
          kind: { type: "string", enum: ["fact", "insight", "preference", "observation", "decision"] },
          salience: { type: "number" },
          confidence: { type: "number" },
        },
        required: ["summary", "content"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "memory.write",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const summary = typeof obj.summary === "string" && obj.summary.trim()
        ? obj.summary.trim().slice(0, 240)
        : "(missing summary)";
      const kind = isKind(obj.kind) ? obj.kind : "fact";
      return {
        kind: "summary",
        title: "Save long-term memory",
        operation: "write",
        warnings: [`${kind[0]?.toUpperCase()}${kind.slice(1)}: ${summary}`],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      if (!input || typeof input !== "object") {
        throw new Error("remember_fact: input must be { summary, content, ... }");
      }
      const obj = input as Record<string, unknown>;
      if (typeof obj.summary !== "string" || !obj.summary.trim()) {
        throw new Error("remember_fact: summary is required");
      }
      if (typeof obj.content !== "string" || !obj.content.trim()) {
        throw new Error("remember_fact: content is required");
      }
      assertSafeMemoryText(obj.summary, obj.content);
      const scope = isScope(obj.scope) ? obj.scope : (workspaceRoot ? "workspace" : "global");
      const candidate = await memoryCandidates.propose({
        scope,
        workspaceScope: scope === "workspace" ? (workspaceRoot ?? (typeof obj.workspaceScope === "string" ? obj.workspaceScope : null)) : null,
        kind: isKind(obj.kind) ? obj.kind : "fact",
        summary: obj.summary.trim().slice(0, 240),
        content: obj.content.trim().slice(0, 4_000),
        salience: clamp01(typeof obj.salience === "number" ? obj.salience : 0.65),
        sourceType: "task",
        sourceId: "tool:remember_fact",
        confidence: clamp01(typeof obj.confidence === "number" ? obj.confidence : 0.85),
      });
      return {
        candidate: {
          id: candidate.id,
          status: candidate.status,
          scope: candidate.scope,
          workspaceScope: candidate.workspaceScope,
          kind: candidate.kind,
          summary: candidate.summary,
          content: candidate.content,
          salience: candidate.salience,
          confidence: candidate.confidence,
        },
      };
    },
  };
}

export function createForgetMemoryTool(memoryService: MemoryService, workspaceRoot?: string): Tool {
  return {
    descriptor: {
      name: "forget_memory",
      description: "Delete a saved Shiguang memory by id. Accepts { id }.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      risk: "write",
      requiresApproval: true,
      capability: "memory.delete",
    },
    previewApproval(input: unknown): ToolApprovalPreview {
      const id = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      return {
        kind: "summary",
        title: "Delete memory",
        operation: "delete",
        warnings: [`Memory id: ${typeof id === "string" ? id : "(missing)"}`],
      };
    },
    async execute(input: unknown): Promise<unknown> {
      const id = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("forget_memory: id is required");
      }
      const existing = await memoryService.get(id);
      if (!existing) {
        throw new Error(`Memory not found: ${id}`);
      }
      if (workspaceRoot && existing.workspaceScope !== workspaceRoot) {
        throw new Error("forget_memory: memory does not belong to the current workspace");
      }
      await memoryService.delete(id);
      return { deleted: true, memory: serializeMemory(existing) };
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

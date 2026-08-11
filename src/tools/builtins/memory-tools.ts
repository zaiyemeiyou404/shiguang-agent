import { randomUUID } from "node:crypto";
import type { Memory, MemoryKind, MemoryScope } from "../../core/types.js";
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
      const workspaceScope = typeof obj.workspaceScope === "string" ? obj.workspaceScope : workspaceRoot;
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

export function createRememberFactTool(memoryService: MemoryService, workspaceRoot?: string): Tool {
  return {
    descriptor: {
      name: "remember_fact",
      description: "Save a durable memory for future runs. Accepts { summary, content, scope?, workspaceScope?, kind?, salience?, confidence? }.",
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
      risk: "write",
      requiresApproval: false,
      capability: "memory.write",
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
      const now = new Date();
      const scope = isScope(obj.scope) ? obj.scope : (workspaceRoot ? "workspace" : "global");
      const memory: Memory = {
        id: `mem_${randomUUID()}`,
        scope,
        workspaceScope: scope === "workspace" ? (typeof obj.workspaceScope === "string" ? obj.workspaceScope : workspaceRoot ?? null) : null,
        kind: isKind(obj.kind) ? obj.kind : "fact",
        summary: obj.summary.trim().slice(0, 240),
        content: obj.content.trim().slice(0, 4_000),
        salience: clamp01(typeof obj.salience === "number" ? obj.salience : 0.65),
        lastAccessedAt: null,
        sourceType: "user",
        sourceId: "tool:remember_fact",
        confidence: clamp01(typeof obj.confidence === "number" ? obj.confidence : 0.85),
        createdAt: now,
        updatedAt: now,
      };
      await memoryService.save(memory);
      return { memory: serializeMemory(memory) };
    },
  };
}

export function createForgetMemoryTool(memoryService: MemoryService): Tool {
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
      await memoryService.delete(id);
      return { deleted: true, memory: serializeMemory(existing) };
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

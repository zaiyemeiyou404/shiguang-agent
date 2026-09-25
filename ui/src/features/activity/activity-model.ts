import type { DesktopConversationEntry, DesktopEvent } from "../../bridge";

type ActivityBase = {
  id: string;
  runId: string | null;
  createdAt: string;
};

export type ResponseActivityItem = ActivityBase & {
  type: "response";
  role: "user" | "assistant";
  from: string;
  content: string;
};

export type ThinkingActivityItem = ActivityBase & {
  type: "thinking";
  content: string;
  steps: string[];
};

export type ToolActivityItem = ActivityBase & {
  type: "tool";
  toolCallId: string | null;
  tool: string;
  input: unknown;
  output: unknown;
  status: "running" | "success" | "error" | "orphan-result";
  callEventId: string | null;
  resultEventId: string | null;
};

export type SystemActivityItem = ActivityBase & {
  type: "system" | "error" | "context";
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type ApprovalActivityItem = ActivityBase & {
  type: "approval";
  approvalId: string | null;
  capability: string;
  request: unknown;
};

export type ActivityItem =
  | ResponseActivityItem
  | ThinkingActivityItem
  | ToolActivityItem
  | SystemActivityItem
  | ApprovalActivityItem;

type OrderedActivity = { item: ActivityItem; order: number; subOrder: number };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringField(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isInternalInstruction(content: string): boolean {
  const text = content.trim();
  return text.startsWith("Relevant Shiguang skills are active.")
    || text.startsWith("Agent profile:")
    || text.startsWith("Pending approvals from prior runs:")
    || text.startsWith("User attached local files for this run.")
    || text.includes("Skill contract: shiguang.skill.v1")
    || text.includes("These are selected user/Agent-authored reusable instructions.");
}

function hasPersistedResponse(
  conversation: readonly DesktopConversationEntry[],
  event: DesktopEvent,
  role: "user" | "assistant",
  content: string,
): boolean {
  return conversation.some((entry) => entry.source === "turn" && entry.role === role && entry.content.trim() === content);
}

function callIdOf(event: DesktopEvent): string | null {
  return stringField(record(event.payload), "toolCallId", "callId", "id");
}

function toolNameOf(event: DesktopEvent): string {
  return stringField(record(event.payload), "tool", "toolName", "name") ?? "未知工具";
}

function eventMessage(event: DesktopEvent): string {
  const payload = record(event.payload);
  return stringField(payload, "message", "content", "reasoning", "reason") ?? (text(event.payload) || "暂无详情");
}

export function mergeDesktopEvents(history: DesktopEvent[], live: DesktopEvent[]): DesktopEvent[] {
  const byId = new Map<string, DesktopEvent>();
  for (const event of [...history, ...live]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function buildActivityItems(
  conversation: DesktopConversationEntry[],
  events: DesktopEvent[],
): ActivityItem[] {
  const ordered: OrderedActivity[] = [];
  const persistedEventIds = new Set(
    conversation
      .filter((entry) => entry.source === "event")
      .flatMap((entry) => [entry.id, entry.id.startsWith("event:") ? entry.id.slice(6) : entry.id]),
  );
  const seenConversationResponses = new Set<string>();

  conversation.forEach((entry, index) => {
    const content = entry.content.trim();
    if (!content) return;
    if (entry.role === "system" && isInternalInstruction(content)) return;
    if (entry.role === "system" || entry.kind === "system" || entry.kind === "error") {
      ordered.push({
        order: Date.parse(entry.createdAt) || index,
        subOrder: index,
        item: {
          id: entry.id,
          runId: entry.runId,
          createdAt: entry.createdAt,
          type: entry.kind === "error" ? "error" : "system",
          message: content,
        },
      });
      return;
    }
    const responseKey = `${entry.runId ?? "no-run"}:${entry.role}:${content}`;
    if (seenConversationResponses.has(responseKey)) return;
    seenConversationResponses.add(responseKey);
    ordered.push({
      order: Date.parse(entry.createdAt) || index,
      subOrder: index,
      item: {
        id: entry.id,
        runId: entry.runId,
        createdAt: entry.createdAt,
        type: "response",
        role: entry.role === "user" ? "user" : "assistant",
        from: entry.from || (entry.role === "user" ? "你" : "拾光 Agent"),
        content,
      },
    });
  });

  const sortedEvents = mergeDesktopEvents([], events);
  const toolCalls = new Map<string, DesktopEvent>();
  const toolResults = new Map<string, DesktopEvent>();
  const handledTools = new Set<string>();
  const thinkingByRun = new Map<string, ThinkingActivityItem>();

  for (const event of sortedEvents) {
    if (event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    const key = callIdOf(event) ?? `${toolNameOf(event)}:${event.kind}:${event.id}`;
    if (event.kind === "tool_call") toolCalls.set(key, event);
    else toolResults.set(key, event);
  }

  sortedEvents.forEach((event, index) => {
    if (persistedEventIds.has(event.id) || persistedEventIds.has(`event:${event.id}`)) return;
    const payload = record(event.payload);
    const eventOrder = Date.parse(event.createdAt) || 1_000_000_000_000 + event.seq;
    const base = { id: `event:${event.id}`, runId: event.runId, createdAt: event.createdAt };

    if (event.kind === "tool_call" || event.kind === "tool_result") {
      const key = callIdOf(event) ?? `${toolNameOf(event)}:${event.kind}:${event.id}`;
      if (handledTools.has(key)) return;
      handledTools.add(key);
      const call = toolCalls.get(key) ?? null;
      const result = toolResults.get(key) ?? null;
      const resultPayload = result ? record(result.payload) : {};
      const isError = resultPayload.isError === true || typeof resultPayload.error === "string";
      ordered.push({
        order: Math.min(...[call, result].filter(Boolean).map((item) => Date.parse(item!.createdAt) || eventOrder)),
        subOrder: index,
        item: {
          ...base,
          id: `tool:${key}`,
          createdAt: (call ?? result ?? event).createdAt,
          type: "tool",
          toolCallId: callIdOf(call ?? result ?? event),
          tool: toolNameOf(call ?? result ?? event),
          input: call ? (record(call.payload).arguments ?? record(call.payload).input ?? null) : null,
          output: result ? (resultPayload.output ?? resultPayload.result ?? resultPayload.error ?? null) : null,
          status: !call && result ? "orphan-result" : !result ? "running" : isError ? "error" : "success",
          callEventId: call?.id ?? null,
          resultEventId: result?.id ?? null,
        },
      });
      return;
    }

    if (event.kind === "message") {
      const content = stringField(payload, "content", "message");
      if (!content) return;
      const role = payload.role === "user" ? "user" : "assistant";
      if (hasPersistedResponse(conversation, event, role, content)) return;
      ordered.push({ order: eventOrder, subOrder: index, item: { ...base, type: "response", role, from: role === "user" ? "你" : "拾光 Agent", content } });
      return;
    }
    if (event.kind === "thinking") {
      const content = eventMessage(event);
      const key = event.runId || "unknown-run";
      const existing = thinkingByRun.get(key);
      if (existing) {
        if (!existing.steps.includes(content)) existing.steps.push(content);
        existing.content = content;
        existing.createdAt = event.createdAt;
      } else {
        const item: ThinkingActivityItem = { ...base, id: `thinking:${key}`, type: "thinking", content, steps: [content] };
        thinkingByRun.set(key, item);
        ordered.push({ order: eventOrder, subOrder: index, item });
      }
      return;
    }
    if (event.kind === "approval_request") {
      ordered.push({
        order: eventOrder,
        subOrder: index,
        item: {
          ...base,
          type: "approval",
          approvalId: stringField(payload, "approvalId"),
          capability: stringField(payload, "capability") ?? "unknown",
          request: payload.request ?? event.payload,
        },
      });
      return;
    }
    if (event.kind === "context_compacted") {
      ordered.push({ order: eventOrder, subOrder: index, item: { ...base, type: "context", message: eventMessage(event), details: payload } });
      return;
    }
    if (event.kind === "error") {
      const code = stringField(payload, "code");
      ordered.push({ order: eventOrder, subOrder: index, item: { ...base, type: "error", message: eventMessage(event), ...(code ? { code } : {}), details: payload } });
      return;
    }
    if (event.kind === "system" || event.kind === "approval_granted" || event.kind === "approval_denied") {
      const prefix = event.kind === "approval_granted" ? "审批已通过" : event.kind === "approval_denied" ? "审批已拒绝" : "";
      const message = eventMessage(event);
      ordered.push({ order: eventOrder, subOrder: index, item: { ...base, type: "system", message: prefix && message === "暂无详情" ? prefix : prefix ? `${prefix}：${message}` : message, details: payload } });
    }
  });

  return ordered
    .sort((a, b) => a.order - b.order || a.subOrder - b.subOrder)
    .map(({ item }) => item);
}

import type {
  DesktopApprovalPreview,
  DesktopApprovalRequest,
  DesktopEventKind,
  DesktopEventPayload,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeApprovalPreview(value: unknown): DesktopApprovalPreview | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = record(value);
  return {
    ...source,
    kind: stringField(source, "kind") ?? "summary",
    title: stringField(source, "title") ?? "操作预览",
    path: stringField(source, "path", "target", "uri"),
    operation: stringField(source, "operation"),
    diff: stringField(source, "diff"),
    additions: typeof source.additions === "number" ? source.additions : null,
    deletions: typeof source.deletions === "number" ? source.deletions : null,
    truncated: source.truncated === true,
    warnings: Array.isArray(source.warnings)
      ? source.warnings.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [],
  };
}

export function normalizeDesktopApprovalRequest(value: unknown): DesktopApprovalRequest {
  const source = record(value);
  return {
    ...source,
    toolName: stringField(source, "toolName", "tool"),
    toolInput: source.toolInput ?? source.input ?? (Object.keys(source).length === 0 ? value : null),
    reason: stringField(source, "reason", "summary", "message"),
    preview: normalizeApprovalPreview(source.preview),
  };
}

export function normalizeDesktopEventPayload(kind: DesktopEventKind, value: unknown): DesktopEventPayload {
  const source = record(value);
  const fallback = stringify(value);
  if (kind === "message") {
    const role = source.role === "user" || source.role === "system" ? source.role : "assistant";
    return { ...source, role, content: stringField(source, "content", "message") ?? fallback };
  }
  if (kind === "thinking") {
    return { ...source, content: stringField(source, "content", "message") ?? fallback };
  }
  if (kind === "tool_call") {
    const input = source.arguments ?? source.input ?? source.toolInput ?? null;
    return {
      ...source,
      toolCallId: stringField(source, "toolCallId", "callId", "id"),
      tool: stringField(source, "tool", "toolName", "name") ?? "unknown",
      input,
      arguments: input,
    };
  }
  if (kind === "tool_result") {
    const error = stringField(source, "error", "message");
    return {
      ...source,
      toolCallId: stringField(source, "toolCallId", "callId", "id"),
      tool: stringField(source, "tool", "toolName", "name") ?? "unknown",
      output: source.output ?? source.result ?? error ?? null,
      isError: source.isError === true || Boolean(error),
      ...(error ? { error } : {}),
    };
  }
  if (kind === "approval_request") {
    return {
      ...source,
      approvalId: stringField(source, "approvalId"),
      pluginId: stringField(source, "pluginId") ?? "unknown",
      capability: stringField(source, "capability") ?? "unknown",
      request: normalizeDesktopApprovalRequest(source.request ?? value),
    };
  }
  return {
    ...source,
    message: stringField(source, "message", "content", "reason") ?? fallback,
    ...(stringField(source, "code") ? { code: stringField(source, "code")! } : {}),
    ...(stringField(source, "approvalId") ? { approvalId: stringField(source, "approvalId")! } : {}),
  };
}

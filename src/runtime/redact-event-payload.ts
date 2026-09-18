const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|password|passwd|secret|cookie|set[_-]?cookie|private[_-]?key)$/i;
const SENSITIVE_VALUE = /\b(?:bearer|basic)\s+[a-z0-9._~+\/-]+=*/i;
const REDACTED = "[REDACTED]";

/**
 * Produces a safe, serializable copy for persisted run events and the desktop UI.
 * Tool execution still receives the original input; only telemetry/history is redacted.
 */
export function redactEventPayload(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0);
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 16) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, seen, depth + 1);
  }
  return output;
}

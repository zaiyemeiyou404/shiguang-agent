import type { BrainAction } from "./types.js";

export type ParseResult =
  | { ok: true; action: BrainAction }
  | { ok: false; error: string };

export function tryParseAction(raw: string): ParseResult {
  const candidates = extractJsonCandidates(raw);
  const errors: string[] = [];

  for (const candidate of candidates) {
    const parsed = tryParseActionObject(candidate);
    if (parsed.ok) {
      return parsed;
    }
    errors.push("error" in parsed ? parsed.error : "Unknown parse error");
  }

  return {
    ok: false,
    error: errors[0] ?? `Failed to parse JSON: ${raw.trim().slice(0, 200)}`,
  };
}

function tryParseActionObject(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Failed to parse JSON: ${raw.slice(0, 200)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Parsed value is not an object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.kind === "respond") {
    if (typeof obj.content !== "string") {
      return { ok: false, error: "respond action missing string content" };
    }
    return { ok: true, action: { kind: "respond", content: obj.content } };
  }

  if (obj.kind === "tool_call") {
    if (typeof obj.toolName !== "string") {
      return { ok: false, error: "tool_call action missing string toolName" };
    }
    return { ok: true, action: { kind: "tool_call", toolName: obj.toolName, toolInput: obj.toolInput } };
  }

  if (obj.kind === "finish") {
    return { ok: true, action: { kind: "finish", content: typeof obj.content === "string" ? obj.content : "Done." } };
  }

  if (obj.kind === "fail") {
    return { ok: true, action: { kind: "fail", reason: typeof obj.reason === "string" ? obj.reason : "Unknown failure" } };
  }

  if (obj.kind === "needs_approval") {
    return {
      ok: true,
      action: {
        kind: "needs_approval",
        toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
        toolInput: obj.toolInput,
        reason: typeof obj.reason === "string" ? obj.reason : "Approval required.",
        approvalId: typeof obj.approvalId === "string" ? obj.approvalId : undefined,
        capability: typeof obj.capability === "string" ? obj.capability : undefined,
      },
    };
  }

  return { ok: false, error: `Unknown action kind: ${JSON.stringify(obj.kind)}` };
}

function extractJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const queue: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    const next = value?.trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    queue.push(next);
  };

  push(trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]);
  push(trimmed);
  push(extractFirstJsonObject(trimmed));

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (!candidate) continue;
    for (const repaired of repairJsonCandidates(candidate)) {
      push(repaired);
    }
  }

  return queue;
}

function repairJsonCandidates(raw: string): string[] {
  const candidates = new Set<string>();
  const normalizedQuotes = normalizeQuotes(raw);
  candidates.add(normalizedQuotes);
  candidates.add(removeTrailingCommas(normalizedQuotes));
  candidates.add(quoteBareKeys(removeTrailingCommas(normalizedQuotes)));
  candidates.add(convertSingleQuotedJson(removeTrailingCommas(normalizedQuotes)));
  candidates.add(convertSingleQuotedJson(quoteBareKeys(removeTrailingCommas(normalizedQuotes))));
  return Array.from(candidates).filter((candidate) => candidate !== raw);
}

function normalizeQuotes(raw: string): string {
  return raw
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function removeTrailingCommas(raw: string): string {
  return raw.replace(/,\s*([}\]])/g, "$1");
}

function quoteBareKeys(raw: string): string {
  return raw.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

function convertSingleQuotedJson(raw: string): string {
  return raw
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '"$1":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
    .replace(/\[\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, '["$1"')
    .replace(/,\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ', "$1"');
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

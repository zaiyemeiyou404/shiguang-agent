import type { DesktopApproval } from "../../bridge";

export interface ApprovalPresentation {
  id: string;
  runId: string;
  pluginId: string;
  capability: string;
  status: DesktopApproval["status"];
  title: string;
  summary: string;
  toolName: string | null;
  target: string | null;
  workingDirectory: string | null;
  operation: string | null;
  warnings: string[];
  diff: string | null;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
  details: Record<string, unknown>;
  rawText: string;
}

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
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeApproval(approval: DesktopApproval): ApprovalPresentation {
  const request = record(approval.request);
  const input = record(request.toolInput ?? request.input);
  const preview = record(request.preview);
  const warnings = Array.isArray(preview.warnings)
    ? preview.warnings.filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
    : [];
  const toolName = stringField(request, "toolName", "tool");
  const previewTitle = stringField(preview, "title");
  const target = stringField(preview, "path", "target", "uri")
    ?? stringField(input, "path", "target", "uri")
    ?? null;
  const workingDirectory = stringField(input, "cwd", "workingDirectory")
    ?? stringField(request, "cwd", "workingDirectory")
    ?? (toolName === "run_terminal_command" ? target : null);
  const summary = stringField(request, "reason", "summary", "message")
    ?? stringField(preview, "summary")
    ?? `此操作需要使用 ${approval.capability} 能力。`;

  return {
    id: approval.id,
    runId: approval.runId,
    pluginId: approval.pluginId,
    capability: approval.capability,
    status: approval.status,
    title: previewTitle ?? (toolName ? `确认执行 ${toolName}` : `确认 ${approval.capability} 操作`),
    summary,
    toolName,
    target,
    workingDirectory,
    operation: stringField(preview, "operation") ?? stringField(request, "operation"),
    warnings,
    diff: stringField(preview, "diff"),
    additions: typeof preview.additions === "number" ? preview.additions : null,
    deletions: typeof preview.deletions === "number" ? preview.deletions : null,
    truncated: preview.truncated === true,
    details: Object.keys(input).length > 0 ? input : request,
    rawText: stringify(approval.request),
  };
}

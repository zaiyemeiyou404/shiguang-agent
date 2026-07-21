import type { ToolApprovalPreview } from "../types.js";

const MAX_DIFF_LINES = 120;
const MAX_LINE_CHARS = 260;

export interface TextDiffPreviewInput {
  path: string;
  before: string;
  after: string;
  operation: string;
  warnings?: string[];
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}

function trimLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}

function countChangedLines(beforeLines: string[], afterLines: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (afterLines[index] !== undefined) additions += 1;
    if (beforeLines[index] !== undefined) deletions += 1;
  }
  return { additions, deletions };
}

export function createTextDiffPreview(input: TextDiffPreviewInput): ToolApprovalPreview {
  const beforeLines = splitLines(input.before);
  const afterLines = splitLines(input.after);
  const { additions, deletions } = countChangedLines(beforeLines, afterLines);

  if (input.before === input.after) {
    return {
      kind: "text_diff",
      title: `${input.operation}: ${input.path}`,
      path: input.path,
      operation: input.operation,
      additions: 0,
      deletions: 0,
      diff: "No text changes.",
      truncated: false,
      warnings: input.warnings,
    };
  }

  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length
    && prefixLength < afterLines.length
    && beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength + prefixLength < beforeLines.length
    && suffixLength + prefixLength < afterLines.length
    && beforeLines[beforeLines.length - 1 - suffixLength] === afterLines[afterLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const contextBeforeStart = Math.max(0, prefixLength - 3);
  const beforeChangeEnd = beforeLines.length - suffixLength;
  const afterChangeEnd = afterLines.length - suffixLength;
  const contextAfterEnd = Math.min(beforeLines.length, beforeChangeEnd + 3);

  const diffLines = [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    `@@ -${contextBeforeStart + 1},${Math.max(1, contextAfterEnd - contextBeforeStart)} +${contextBeforeStart + 1},${Math.max(1, afterChangeEnd - contextBeforeStart + Math.min(3, suffixLength))} @@`,
  ];

  for (let index = contextBeforeStart; index < prefixLength; index += 1) {
    diffLines.push(` ${trimLine(beforeLines[index] ?? "")}`);
  }
  for (let index = prefixLength; index < beforeChangeEnd; index += 1) {
    diffLines.push(`-${trimLine(beforeLines[index] ?? "")}`);
  }
  for (let index = prefixLength; index < afterChangeEnd; index += 1) {
    diffLines.push(`+${trimLine(afterLines[index] ?? "")}`);
  }
  for (let index = beforeChangeEnd; index < contextAfterEnd; index += 1) {
    diffLines.push(` ${trimLine(beforeLines[index] ?? "")}`);
  }

  const truncated = diffLines.length > MAX_DIFF_LINES;
  const visibleLines = truncated
    ? [...diffLines.slice(0, MAX_DIFF_LINES), "...[diff truncated]"]
    : diffLines;

  return {
    kind: "text_diff",
    title: `${input.operation}: ${input.path}`,
    path: input.path,
    operation: input.operation,
    additions,
    deletions,
    diff: visibleLines.join("\n"),
    truncated,
    warnings: input.warnings,
  };
}

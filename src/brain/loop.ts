import type {
  BrainInput,
  BrainDecision,
  ActionResult,
  ActionResultCategory,
  WorkingMemorySnapshot,
} from "./types.js";
import type { Planner } from "./planner.js";
import type { Policy } from "./policy.js";
import type { Evaluator, LoopStopReason } from "./evaluator.js";
import type { ValidationModeHint } from "../tools/types.js";

export interface LoopDeps {
  planner: Planner;
  policy: Policy;
  dispatcher: {
    dispatch(decision: BrainDecision): Promise<ActionResult>;
  };
  evaluator: Evaluator;
}

export interface LoopState {
  steps: number;
  history: ActionResult[];
  workingMemory: WorkingMemorySnapshot;
  lastDecision: BrainDecision | null;
  lastResult: ActionResult | null;
  stopReason: LoopStopReason | null;
  stopSummary: string | null;
}

function createInitialWorkingMemory(input: BrainInput): WorkingMemorySnapshot {
  return input.workingMemory ?? {
    step: 0,
    lastActionKind: null,
  };
}

function observationCategory(result: ActionResult): ActionResultCategory {
  return result.metadata?.category ?? (result.ok ? "tool_observation" : "runtime_error");
}

function observationSummary(result: ActionResult): string {
  if (result.metadata?.summary) {
    return result.metadata.summary;
  }

  if (result.error) {
    return result.error;
  }

  if (typeof result.output === "string") {
    return result.output.slice(0, 500);
  }

  return (JSON.stringify(result.output) ?? "").slice(0, 500);
}

function updateWorkingMemory(
  previous: WorkingMemorySnapshot,
  step: number,
  result: ActionResult,
): WorkingMemorySnapshot {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  const isRetryableToolError = result.metadata?.category === "tool_error"
    && result.metadata.retryable === true
    && typeof toolName === "string";
  const validationFailure = inferValidationFailure(result);

  return {
    step,
    lastActionKind: result.action.kind,
    ...(toolName ? { lastToolName: toolName } : {}),
    lastObservation: {
      category: observationCategory(result),
      summary: observationSummary(result),
    },
    ...(validationFailure
      ? { validationFailure }
      : result.metadata?.toolName === "run_validation"
        ? {}
        : previous.validationFailure
          ? { validationFailure: previous.validationFailure }
          : {}),
    ...(isRetryableToolError
      ? {
          retryableToolErrors: {
            toolName,
            count: previous.retryableToolErrors?.toolName === toolName
              ? previous.retryableToolErrors.count + 1
              : 1,
          },
        }
      : {}),
  };
}

function inferValidationFailure(result: ActionResult): WorkingMemorySnapshot["validationFailure"] | undefined {
  if (result.metadata?.toolName !== "run_validation" || result.ok !== true) return undefined;
  if (!result.output || typeof result.output !== "object") return undefined;

  const output = result.output as {
    ok?: unknown;
    mode?: unknown;
    summary?: unknown;
    commands?: Array<{ name?: unknown; ok?: unknown; stdout?: unknown; stderr?: unknown }>;
  };

  if (output.ok !== false) return undefined;

  const mode = typeof output.mode === "string" ? output.mode as ValidationModeHint : "all";
  const summary = typeof output.summary === "string" ? output.summary : "Validation failed.";
  const failingCommands = Array.isArray(output.commands)
    ? output.commands
      .filter((command) => command && command.ok === false && typeof command.name === "string")
      .map((command) => command.name as string)
    : [];
  const rankedFailure = rankValidationFailure(mode, output.commands);
  const stdoutSnippet = rankedFailure?.stdoutSnippet;
  const stderrSnippet = rankedFailure?.stderrSnippet;
  const suspectLocation = rankedFailure?.suspectLocation;

  return {
    mode,
    failingCommands,
    summary,
    ...(stdoutSnippet ? { stdoutSnippet } : {}),
    ...(stderrSnippet ? { stderrSnippet } : {}),
    ...(suspectLocation?.file ? { suspectFile: suspectLocation.file } : {}),
    ...(typeof suspectLocation?.line === "number" ? { suspectLine: suspectLocation.line } : {}),
    ...(typeof suspectLocation?.column === "number" ? { suspectColumn: suspectLocation.column } : {}),
    ...(suspectLocation?.errorCode ? { suspectErrorCode: suspectLocation.errorCode } : {}),
    ...(suspectLocation?.importPath ? { suspectImportPath: suspectLocation.importPath } : {}),
    ...(suspectLocation?.importStyle ? { suspectImportStyle: suspectLocation.importStyle } : {}),
    ...(suspectLocation?.exportName ? { suspectExportName: suspectLocation.exportName } : {}),
    ...(suspectLocation?.failingTestName ? { failingTestName: suspectLocation.failingTestName } : {}),
    ...(suspectLocation?.assertExpected ? { assertExpected: suspectLocation.assertExpected } : {}),
    ...(suspectLocation?.assertActual ? { assertActual: suspectLocation.assertActual } : {}),
    ...(suspectLocation?.assertDiffSummary ? { assertDiffSummary: suspectLocation.assertDiffSummary } : {}),
  };
}

function rankValidationFailure(
  mode: ValidationModeHint,
  commands: Array<{ name?: unknown; ok?: unknown; stdout?: unknown; stderr?: unknown }> | undefined,
): {
  stdoutSnippet?: string;
  stderrSnippet?: string;
  suspectLocation?: ReturnType<typeof inferSuspectLocation>;
} | undefined {
  const failingCommands = Array.isArray(commands)
    ? commands.filter((command) => command && command.ok === false)
    : [];

  let best: {
    score: number;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    suspectLocation?: ReturnType<typeof inferSuspectLocation>;
  } | undefined;

  for (const command of failingCommands) {
    const stdoutSnippet = typeof command.stdout === "string" && command.stdout.length > 0
      ? command.stdout
      : undefined;
    const stderrSnippet = typeof command.stderr === "string" && command.stderr.length > 0
      ? command.stderr
      : undefined;
    const suspectLocation = inferSuspectLocation({
      mode,
      commandName: typeof command.name === "string" ? command.name : undefined,
      text: stderrSnippet ?? stdoutSnippet ?? "",
      fallbackText: stdoutSnippet ?? stderrSnippet ?? "",
    });
    const score = scoreSuspectLocation(suspectLocation) + (stderrSnippet ? 1 : 0) + (stdoutSnippet ? 1 : 0);

    if (!best || score > best.score) {
      best = { score, stdoutSnippet, stderrSnippet, suspectLocation };
    }
  }

  return best;
}

function scoreSuspectLocation(suspectLocation: ReturnType<typeof inferSuspectLocation>): number {
  if (!suspectLocation) return 0;

  let score = 0;
  if (suspectLocation.file) {
    score += 3;
    if (/node_modules\//.test(suspectLocation.file)) {
      score -= 2;
    }
    if (/\.test\.|tests?\//.test(suspectLocation.file)) {
      score -= 1;
    } else {
      score += 2;
    }
  }
  if (typeof suspectLocation.line === "number") score += 2;
  if (typeof suspectLocation.column === "number") score += 1;
  if (suspectLocation.errorCode) score += 1;
  if (suspectLocation.importPath) score += 7;
  if (suspectLocation.importStyle) score += 3;
  if (suspectLocation.exportName) score += 4;
  if (suspectLocation.failingTestName) score += 1;
  if (suspectLocation.assertExpected) score += 2;
  if (suspectLocation.assertActual) score += 2;
  if (suspectLocation.assertDiffSummary) score += 2;
  return score;
}

function inferSuspectLocation(input: {
  mode: ValidationModeHint;
  commandName?: string;
  text: string;
  fallbackText?: string;
}): {
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  importPath?: string;
  importStyle?: string;
  exportName?: string;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {

  const primaryText = input.text;
  const secondaryText = input.fallbackText ?? "";
  const parserHint = input.commandName ?? input.mode;

  const specialized = inferSpecializedSuspectLocation(parserHint, primaryText, secondaryText);
  if (specialized) return specialized;

  return inferGenericSuspectLocation(primaryText || secondaryText);
}

function inferSpecializedSuspectLocation(
  parserHint: string,
  primaryText: string,
  secondaryText: string,
): {
  file?: string;
  line?: number;
  column?: number;
  errorCode?: string;
  importPath?: string;
  importStyle?: string;
  exportName?: string;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {
  if (parserHint === "typecheck") {
    return inferTypecheckSuspectLocation(primaryText || secondaryText);
  }

  if (parserHint === "test") {
    return inferTestSuspectLocation(primaryText || secondaryText);
  }

  if (parserHint === "build") {
    return inferBuildSuspectLocation(primaryText || secondaryText);
  }

  return undefined;
}

function inferTypecheckSuspectLocation(text: string): { file?: string; line?: number; column?: number; errorCode?: string } | undefined {
  if (!text) return undefined;

  const fileLineMatch = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/) 
    ?? text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\)/);
  const errorCodeMatch = text.match(/\b([A-Z]{2,}\d{3,})\b/);

  if (!fileLineMatch && !errorCodeMatch) return undefined;

  return {
    ...(fileLineMatch?.[1] ? { file: fileLineMatch[1] } : {}),
    ...(fileLineMatch?.[2] ? { line: Number(fileLineMatch[2]) } : {}),
    ...(fileLineMatch?.[3] ? { column: Number(fileLineMatch[3]) } : {}),
    ...(errorCodeMatch?.[1] ? { errorCode: errorCodeMatch[1] } : {}),
  };
}

function inferTestSuspectLocation(text: string): {
  file?: string;
  line?: number;
  column?: number;
  failingTestName?: string;
  assertExpected?: string;
  assertActual?: string;
  assertDiffSummary?: string;
} | undefined {
  if (!text) return undefined;

  const failingTestMatch = text.match(/^FAILED\s+([^\s]+)\s+-/m)
    ?? text.match(/^\s*FAIL\s+(.+)$/m);
  const fileLineMatches = Array.from(text.matchAll(/([A-Za-z0-9_./\\-]+\.(?:py|ts|tsx|js|jsx)):(\d+)(?::(\d+))?/g));
  const preferredFileLineMatch = choosePreferredSourceFrame(fileLineMatches);
  const expectedValue = extractAssertionBlock(text, "Expected", ["Received", "Actual"]);
  const actualValue = extractAssertionBlock(text, "Received", []) ?? extractAssertionBlock(text, "Actual", []);
  const assertDiffSummary = expectedValue && actualValue
    ? summarizeAssertionDiff(expectedValue, actualValue)
    : summarizeSnapshotStyleDiff(text);

  if (!failingTestMatch && !preferredFileLineMatch && !expectedValue && !actualValue) return undefined;

  return {
    ...(failingTestMatch?.[1] ? { failingTestName: failingTestMatch[1] } : {}),
    ...(preferredFileLineMatch?.[1] ? { file: preferredFileLineMatch[1] } : {}),
    ...(preferredFileLineMatch?.[2] ? { line: Number(preferredFileLineMatch[2]) } : {}),
    ...(preferredFileLineMatch?.[3] ? { column: Number(preferredFileLineMatch[3]) } : {}),
    ...(expectedValue ? { assertExpected: expectedValue } : {}),
    ...(actualValue ? { assertActual: actualValue } : {}),
    ...(assertDiffSummary ? { assertDiffSummary } : {}),
  };
}

function choosePreferredSourceFrame(matches: RegExpMatchArray[]): RegExpMatchArray | undefined {
  const score = (filePath: string): number => {
    let value = 0;
    if (!/node_modules\//.test(filePath)) value += 5;
    if (!/\.test\.|tests?\//.test(filePath)) value += 4;
    if (/^src\//.test(filePath)) value += 3;
    return value;
  };

  return matches
    .map((match) => ({ match, score: score(match[1] ?? "") }))
    .sort((a, b) => b.score - a.score)[0]?.match;
}

function extractAssertionBlock(text: string, label: "Expected" | "Received" | "Actual", stopLabels: Array<"Expected" | "Received" | "Actual">): string | undefined {
  const lines = text.split("\n");
  const startIndex = lines.findIndex((line) => line.startsWith(`${label}:`));
  if (startIndex === -1) return undefined;

  const firstRawLine = lines[startIndex];
  if (typeof firstRawLine !== "string") return undefined;
  const firstLine = firstRawLine.slice(`${label}:`.length).trimStart();
  const collected = [firstLine];

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    if (stopLabels.some((stopLabel) => line.startsWith(`${stopLabel}:`))) break;
    if (/^\s*[❯›>]/.test(line)) break;
    if (/^\s*at\s+/.test(line)) break;
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function summarizeAssertionDiff(expected: string, actual: string): string {
  const structured = summarizeStructuredAssertionDiff(expected, actual);
  if (structured) return structured;

  const compact = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 120);
  return `Expected ${compact(expected)} but received ${compact(actual)}`;
}

function summarizeStructuredAssertionDiff(expected: string, actual: string): string | undefined {
  const parsedExpected = tryParseStructuredAssertionValue(expected);
  const parsedActual = tryParseStructuredAssertionValue(actual);
  if (!parsedExpected || !parsedActual) return undefined;

  if (Array.isArray(parsedExpected) && Array.isArray(parsedActual)) {
    return summarizeArrayAssertionDiff(parsedExpected, parsedActual);
  }

  if (isPlainObject(parsedExpected) && isPlainObject(parsedActual)) {
    return summarizeObjectAssertionDiff(parsedExpected, parsedActual);
  }

  return undefined;
}

function summarizeObjectAssertionDiff(expected: Record<string, unknown>, actual: Record<string, unknown>): string | undefined {
  const pathDiffs = collectAssertionPathDiffs(expected, actual);
  const missingPaths = collectMissingAssertionPaths(expected, actual);
  const unexpectedPaths = collectUnexpectedAssertionPaths(expected, actual);

  const parts: string[] = [];
  if (pathDiffs.length > 0) {
    parts.push(`Mismatched paths: ${pathDiffs.map((diff) => `${diff.path} (expected ${formatAssertionValue(diff.expected)}, received ${formatAssertionValue(diff.actual)})`).join(", ")}`);
  }
  if (missingPaths.length > 0) {
    parts.push(`Missing keys in actual: ${missingPaths.join(", ")}`);
  }
  if (unexpectedPaths.length > 0) {
    parts.push(`Unexpected keys in actual: ${unexpectedPaths.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function summarizeArrayAssertionDiff(expected: unknown[], actual: unknown[]): string | undefined {
  const mismatchedEntries: string[] = [];
  const maxLength = Math.max(expected.length, actual.length);

  for (let index = 0; index < maxLength; index++) {
    const hasExpected = index < expected.length;
    const hasActual = index < actual.length;
    if (hasExpected && hasActual) {
      if (!deepEqualAssertionValue(expected[index], actual[index])) {
        mismatchedEntries.push(`[${index}] expected ${formatAssertionValue(expected[index])}, received ${formatAssertionValue(actual[index])}`);
      }
      continue;
    }
  }

  const missingEntries = expected
    .slice(actual.length)
    .map((value, offset) => `[${actual.length + offset}]=${formatAssertionValue(value)}`);
  const unexpectedEntries = actual
    .slice(expected.length)
    .map((value, offset) => `[${expected.length + offset}]=${formatAssertionValue(value)}`);

  const parts: string[] = [];
  if (mismatchedEntries.length > 0) {
    parts.push(`Array diffs: ${mismatchedEntries.join(", ")}`);
  }
  if (missingEntries.length > 0) {
    parts.push(`Missing items in actual: ${missingEntries.join(", ")}`);
  }
  if (unexpectedEntries.length > 0) {
    parts.push(`Unexpected items in actual: ${unexpectedEntries.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function summarizeSnapshotStyleDiff(text: string): string | undefined {
  const lines = text.split("\n");
  const removedLines = lines.filter((line) => /^-\s+/.test(line));
  const addedLines = lines.filter((line) => /^\+\s+/.test(line));
  if (removedLines.length === 0 || addedLines.length === 0) return undefined;

  const pairCount = Math.min(removedLines.length, addedLines.length);
  const pairs: string[] = [];
  for (let index = 0; index < pairCount; index++) {
    const removed = removedLines[index]?.replace(/^-\s*/, "").trim();
    const added = addedLines[index]?.replace(/^\+\s*/, "").trim();
    if (!removed || !added) continue;

    const removedEntry = parseSnapshotDiffEntry(removed);
    const addedEntry = parseSnapshotDiffEntry(added);
    if (!removedEntry || !addedEntry) continue;
    if (removedEntry.key !== addedEntry.key) continue;

    pairs.push(`${removedEntry.key} (removed ${removedEntry.value}, added ${addedEntry.value})`);
  }

  return pairs.length > 0 ? `Snapshot diffs: ${pairs.join(", ")}` : undefined;
}

function parseSnapshotDiffEntry(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^"?([^":]+)"?\s*:\s*(.+?)(,)?$/);
  if (!match) return undefined;
  return {
    key: match[1]?.trim() ?? "",
    value: (match[2] ?? "").trim(),
  };
}

function collectAssertionPathDiffs(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): Array<{ path: string; expected: unknown; actual: unknown }> {
  const diffs: Array<{ path: string; expected: unknown; actual: unknown }> = [];

  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) continue;

    const nextPath = prefix ? `${prefix}.${key}` : key;
    const expectedValue = expected[key];
    const actualValue = actual[key];

    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      diffs.push(...collectAssertionPathDiffs(expectedValue, actualValue, nextPath));
      continue;
    }

    if (!deepEqualAssertionValue(expectedValue, actualValue)) {
      diffs.push({ path: nextPath, expected: expectedValue, actual: actualValue });
    }
  }

  return diffs;
}

function collectMissingAssertionPaths(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];

  for (const key of Object.keys(expected)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      paths.push(nextPath);
      continue;
    }

    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      paths.push(...collectMissingAssertionPaths(expectedValue, actualValue, nextPath));
    }
  }

  return paths;
}

function collectUnexpectedAssertionPaths(expected: Record<string, unknown>, actual: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];

  for (const key of Object.keys(actual)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      paths.push(nextPath);
      continue;
    }

    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      paths.push(...collectUnexpectedAssertionPaths(expectedValue, actualValue, nextPath));
    }
  }

  return paths;
}

function tryParseStructuredAssertionValue(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualAssertionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatAssertionValue(value: unknown): string {
  return JSON.stringify(value);
}

function inferBuildSuspectLocation(text: string): { file?: string; importPath?: string; importStyle?: string; exportName?: string } | undefined {
  if (!text) return undefined;

  const resolveMatch = text.match(/Could not resolve\s+"([^"]+)"\s+from\s+"([^"]+)"/);
  if (resolveMatch) {
    return {
      importPath: resolveMatch[1],
      file: resolveMatch[2],
    };
  }

  const moduleNotFoundMatch = text.match(/Can't resolve\s+'([^']+)'/);
  if (moduleNotFoundMatch) {
    return {
      importPath: moduleNotFoundMatch[1],
    };
  }

  const exportMismatchMatch = text.match(/module\s+'([^']+)'\s+does not provide an export named\s+'([^']+)'/i)
    ?? text.match(/module\s+"([^"]+)"\s+does not provide an export named\s+"([^"]+)"/i)
    ?? text.match(/requested module\s+'([^']+)'\s+does not provide an export named\s+'([^']+)'/i)
    ?? text.match(/requested module\s+"([^"]+)"\s+does not provide an export named\s+"([^"]+)"/i);
  if (exportMismatchMatch) {
    return {
      file: exportMismatchMatch[1],
      exportName: exportMismatchMatch[2],
    };
  }

  const webpackExportMismatchMatch = text.match(/export\s+'([^']+)'\s+\(imported as\s+'([^']+)'\)\s+was not found in\s+'([^']+)'/i)
    ?? text.match(/export\s+"([^"]+)"\s+\(imported as\s+"([^"]+)"\)\s+was not found in\s+"([^"]+)"/i);
  if (webpackExportMismatchMatch) {
    const requestedExport = webpackExportMismatchMatch[1] || webpackExportMismatchMatch[2];
    const importStyle = requestedExport === "default" ? "default" : "named";
    return {
      file: webpackExportMismatchMatch[3],
      exportName: requestedExport,
      importStyle,
    };
  }

  const esbuildExportMismatchMatch = text.match(/No matching export in\s+"([^"]+)"\s+for import\s+"([^"]+)"/i)
    ?? text.match(/No matching export in\s+'([^']+)'\s+for import\s+'([^']+)'/i);
  if (esbuildExportMismatchMatch) {
    const requestedExport = esbuildExportMismatchMatch[2];
    const importStyle = requestedExport === "default" ? "default" : "named";
    return {
      file: esbuildExportMismatchMatch[1],
      exportName: requestedExport,
      importStyle,
    };
  }

  const missingDefaultExportMatch = text.match(/Attempted import error:\s+'([^']+)'\s+does not contain a default export/i);
  if (missingDefaultExportMatch) {
    return {
      file: missingDefaultExportMatch[1],
      exportName: "default",
      importStyle: "default",
    };
  }

  const missingNamedExportMatch = text.match(/Attempted import error:\s+'([^']+)'\s+is not exported from\s+'([^']+)'/i);
  if (missingNamedExportMatch) {
    return {
      file: missingNamedExportMatch[2],
      exportName: missingNamedExportMatch[1],
      importStyle: "named",
    };
  }

  return undefined;
}

function inferGenericSuspectLocation(text: string): { file?: string; line?: number; column?: number; errorCode?: string } | undefined {
  if (!text) return undefined;

  const fileLineMatch = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/);
  const errorCodeMatch = text.match(/\b([A-Z]{2,}\d{3,})\b/);

  if (!fileLineMatch && !errorCodeMatch) return undefined;

  return {
    ...(fileLineMatch?.[1] ? { file: fileLineMatch[1] } : {}),
    ...(fileLineMatch?.[2] ? { line: Number(fileLineMatch[2]) } : {}),
    ...(fileLineMatch?.[3] ? { column: Number(fileLineMatch[3]) } : {}),
    ...(errorCodeMatch?.[1] ? { errorCode: errorCodeMatch[1] } : {}),
  };
}

export async function runLoop(
  input: BrainInput,
  deps: LoopDeps,
  maxSteps = 10,
): Promise<LoopState> {
  const state: LoopState = {
    steps: 0,
    history: [],
    workingMemory: createInitialWorkingMemory(input),
    lastDecision: null,
    lastResult: null,
    stopReason: null,
    stopSummary: null,
  };
  input = { ...input, workingMemory: state.workingMemory };

  for (let i = 0; i < maxSteps; i++) {
    state.steps++;

    const decision = await deps.planner.decide(input);
    const approved = await deps.policy.check(decision);
    state.lastDecision = approved;

    const result = await deps.dispatcher.dispatch(approved);
    state.lastResult = result;
    state.history.push(result);
    state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, result);

    const action = await deps.evaluator.evaluate(approved, result, state.history);
    if (action.kind === "stop") {
      state.stopReason = action.reason;
      state.stopSummary = action.summary ?? null;
      break;
    }

    input = { ...input, history: state.history, workingMemory: state.workingMemory };
  }

  return state;
}

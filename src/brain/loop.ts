import type {
  BrainInput,
  BrainDecision,
  ActionResult,
  ActionResultCategory,
  PlannerPhase,
  WorkingMemorySnapshot,
} from "./types.js";
import type { Planner } from "./planner.js";
import type { Policy } from "./policy.js";
import type { Evaluator, LoopStopReason } from "./evaluator.js";
import type { ToolExecutionContext, ValidationModeHint } from "../tools/types.js";

export interface LoopDeps {
  planner: Planner;
  policy: Policy;
  dispatcher: {
    dispatch(decision: BrainDecision, context?: ToolExecutionContext): Promise<ActionResult>;
  };
  evaluator: Evaluator;
}

export interface LoopContext {
  signal?: AbortSignal;
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

const MAX_REPAIR_VALIDATION_FAILURES_PER_SUSPECT = 2;
const MAX_REPAIR_ATTEMPT_HISTORY = 6;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function createInitialWorkingMemory(input: BrainInput): WorkingMemorySnapshot {
  return {
    // 所有 run 默认从 investigate 起步；resume 时再由外部注入已有 workingMemory 覆盖。
    phase: "investigate",
    step: 0,
    lastActionKind: null,
    ...input.workingMemory,
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
  const repairAttempt = updateRepairAttempt(previous, result, validationFailure);

  return {
    step,
    // phase 由“刚执行完的结果”反推，而不是由 planner 口头声明，避免状态漂移。
    phase: inferNextPhase(previous.phase ?? "investigate", result, validationFailure, repairAttempt),
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
    ...(repairAttempt ? { repairAttempt } : {}),
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

function inferNextPhase(
  previousPhase: PlannerPhase,
  result: ActionResult,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  repairAttempt: WorkingMemorySnapshot["repairAttempt"],
): PlannerPhase {
  // finish/fail/respond 都意味着当前回合已经可以进入对外总结阶段。
  if (result.action.kind === "finish" || result.action.kind === "fail" || result.action.kind === "respond") {
    return "summarize";
  }

  if (result.action.kind !== "tool_call") {
    return previousPhase;
  }

  const toolName = result.metadata?.toolName ?? result.action.toolName;
  if (toolName === "run_validation") {
    // validation 成功则总结；失败但有 suspectFile 则进入 edit / exhausted investigate。
    if (validationFailure?.suspectFile) return repairAttempt?.exhausted ? "investigate" : "edit";
    if (validationFailure) return "investigate";
    return result.ok ? "summarize" : "validate";
  }

  if (toolName === "completion_check") {
    const output = result.output as { status?: unknown } | null;
    if (output?.status === "needs_repair") {
      return validationFailure?.suspectFile ? "edit" : "investigate";
    }
    return "summarize";
  }

  if (result.metadata?.workspaceMutation === true) {
    return "validate";
  }

  if (toolName === "search_workspace") {
    return "investigate";
  }

  if (toolName === "read_text_file" && repairAttempt?.exhausted === true) {
    return "investigate";
  }

  if (result.ok && result.metadata?.category === "tool_observation") {
    return "summarize";
  }

  return previousPhase;
}

function updateRepairAttempt(
  previous: WorkingMemorySnapshot,
  result: ActionResult,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
): WorkingMemorySnapshot["repairAttempt"] | undefined {
  const toolName = result.metadata?.toolName ?? result.action.toolName;

  if (toolName === "run_validation") {
    // repairAttempt 以 suspectFile 为主键累计，避免把不同故障混成一条修复历史。
    if (!validationFailure?.suspectFile) return undefined;

    const previousForSameSuspect = previous.repairAttempt?.suspectFile === validationFailure.suspectFile
      ? previous.repairAttempt
      : undefined;
    const validationFailureCount = (previousForSameSuspect?.validationFailureCount ?? 0) + 1;
    const editAttemptCount = previousForSameSuspect?.editAttemptCount ?? 0;

    return {
      suspectFile: validationFailure.suspectFile,
      validationFailureCount,
      editAttemptCount,
      exhausted: validationFailureCount >= MAX_REPAIR_VALIDATION_FAILURES_PER_SUSPECT,
      ...(previousForSameSuspect?.lastStrategy ? { lastStrategy: previousForSameSuspect.lastStrategy } : {}),
      ...(previousForSameSuspect?.lastPatchSignature ? { lastPatchSignature: previousForSameSuspect.lastPatchSignature } : {}),
      ...(previousForSameSuspect?.triedStrategies ? { triedStrategies: previousForSameSuspect.triedStrategies } : {}),
      ...(previousForSameSuspect?.triedSuspectPaths ? { triedSuspectPaths: previousForSameSuspect.triedSuspectPaths } : {}),
      ...(previousForSameSuspect?.triedStrategyPaths ? { triedStrategyPaths: previousForSameSuspect.triedStrategyPaths } : {}),
      ...(previousForSameSuspect?.exhaustedSearchQuery ? { exhaustedSearchQuery: previousForSameSuspect.exhaustedSearchQuery } : {}),
      ...(previousForSameSuspect?.exhaustedSearchCandidatePaths ? { exhaustedSearchCandidatePaths: previousForSameSuspect.exhaustedSearchCandidatePaths } : {}),
      ...(previousForSameSuspect?.exhaustedReadCandidatePaths ? { exhaustedReadCandidatePaths: previousForSameSuspect.exhaustedReadCandidatePaths } : {}),
    };
  }

  if (toolName === "search_workspace") {
    // exhausted 后的 search 不是普通搜索，而是在为“下一批候选 suspect”留痕。
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!currentSuspect || previous.repairAttempt?.exhausted !== true) return previous.repairAttempt;
    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;
    if (!previousForSameSuspect) return previous.repairAttempt;

    const toolInput = result.action.toolInput as { query?: unknown } | null;
    const query = typeof toolInput?.query === "string" ? toolInput.query : undefined;
    const searchCandidatePaths = inferSearchResultPaths(result);

    return {
      ...previousForSameSuspect,
      ...(query ? { exhaustedSearchQuery: query } : {}),
      ...(searchCandidatePaths.length > 0 ? { exhaustedSearchCandidatePaths: searchCandidatePaths.slice(0, MAX_REPAIR_ATTEMPT_HISTORY) } : {}),
    };
  }

  if (toolName === "read_text_file" && previous.repairAttempt?.exhausted === true) {
    // exhausted 阶段读过哪些候选路径也要记住，避免反复读同一批文件。
    const readPath = inferReadResultPath(result);
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!readPath || !currentSuspect) return previous.repairAttempt;
    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;
    if (!previousForSameSuspect) return previous.repairAttempt;

    return {
      ...previousForSameSuspect,
      exhaustedReadCandidatePaths: compactAppend(previousForSameSuspect.exhaustedReadCandidatePaths, readPath),
    };
  }

  const mutationPath = inferWorkspaceMutationPath(result);
  if (mutationPath) {
    // 只有改到了 suspect 或其候选文件，才把这次写操作记入 repairAttempt。
    const currentSuspect = previous.validationFailure?.suspectFile ?? previous.repairAttempt?.suspectFile;
    if (!currentSuspect) return undefined;
    if (!isRepairSuspectPath(previous.validationFailure, mutationPath)
      && !previous.repairAttempt?.exhaustedSearchCandidatePaths?.includes(mutationPath)) return undefined;

    const previousForSameSuspect = previous.repairAttempt?.suspectFile === currentSuspect
      ? previous.repairAttempt
      : undefined;

    return {
      suspectFile: currentSuspect,
      validationFailureCount: previousForSameSuspect?.validationFailureCount ?? 0,
      editAttemptCount: (previousForSameSuspect?.editAttemptCount ?? 0) + 1,
      exhausted: previousForSameSuspect?.exhausted ?? false,
      ...(previousForSameSuspect?.lastStrategy ? { lastStrategy: previousForSameSuspect.lastStrategy } : {}),
      ...(previousForSameSuspect?.lastPatchSignature ? { lastPatchSignature: previousForSameSuspect.lastPatchSignature } : {}),
      ...(previousForSameSuspect?.triedStrategies ? { triedStrategies: previousForSameSuspect.triedStrategies } : {}),
      ...(previousForSameSuspect?.triedSuspectPaths ? { triedSuspectPaths: previousForSameSuspect.triedSuspectPaths } : {}),
      ...(previousForSameSuspect?.triedStrategyPaths ? { triedStrategyPaths: previousForSameSuspect.triedStrategyPaths } : {}),
      ...(previousForSameSuspect?.exhaustedSearchQuery ? { exhaustedSearchQuery: previousForSameSuspect.exhaustedSearchQuery } : {}),
      ...(previousForSameSuspect?.exhaustedSearchCandidatePaths ? { exhaustedSearchCandidatePaths: previousForSameSuspect.exhaustedSearchCandidatePaths } : {}),
      ...(previousForSameSuspect?.exhaustedReadCandidatePaths ? { exhaustedReadCandidatePaths: previousForSameSuspect.exhaustedReadCandidatePaths } : {}),
      ...inferRepairPatchAttempt(result, mutationPath, previous.validationFailure, previousForSameSuspect),
    };
  }

  return previous.repairAttempt;
}

function inferRepairPatchAttempt(
  result: ActionResult,
  mutationPath: string,
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  previousRepairAttempt: WorkingMemorySnapshot["repairAttempt"],
): Pick<NonNullable<WorkingMemorySnapshot["repairAttempt"]>, "lastStrategy" | "lastPatchSignature" | "triedStrategies" | "triedSuspectPaths" | "triedStrategyPaths"> {
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  const toolInput = result.action.toolInput as Record<string, unknown> | null;
  const lastStrategy = describeRepairStrategy(validationFailure, toolName);

  if (toolName === "patch_text_file") {
    const oldString = typeof toolInput?.oldString === "string" ? toolInput.oldString : undefined;
    const newString = typeof toolInput?.newString === "string" ? toolInput.newString : undefined;
    if (oldString && newString) {
      const lastPatchSignature = createPatchSignature(mutationPath, oldString, newString);
      return {
        lastStrategy,
        lastPatchSignature,
        ...inferCompactAttemptHistory(previousRepairAttempt, lastStrategy, mutationPath),
      };
    }
  }

  if (toolName === "write_text_file") {
    const content = typeof toolInput?.content === "string" ? toolInput.content : undefined;
    if (typeof content === "string") {
      const lastPatchSignature = createWriteSignature(mutationPath, content);
      return {
        lastStrategy,
        lastPatchSignature,
        ...inferCompactAttemptHistory(previousRepairAttempt, lastStrategy, mutationPath),
      };
    }
  }

  return {};
}

function inferCompactAttemptHistory(
  previousRepairAttempt: WorkingMemorySnapshot["repairAttempt"],
  lastStrategy: string,
  mutationPath: string,
): Pick<NonNullable<WorkingMemorySnapshot["repairAttempt"]>, "triedStrategies" | "triedSuspectPaths" | "triedStrategyPaths"> {
  if (previousRepairAttempt?.exhausted !== true
    && !previousRepairAttempt?.triedStrategies
    && !previousRepairAttempt?.triedSuspectPaths
    && !previousRepairAttempt?.triedStrategyPaths) {
    return {};
  }

  return {
    triedStrategies: compactAppend(previousRepairAttempt?.triedStrategies, lastStrategy),
    triedSuspectPaths: compactAppend(previousRepairAttempt?.triedSuspectPaths, mutationPath),
    triedStrategyPaths: compactAppend(previousRepairAttempt?.triedStrategyPaths, createStrategyPathKey(lastStrategy, mutationPath)),
  };
}

function isRepairSuspectPath(
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  path: string,
): boolean {
  return inferRepairSuspectPaths(validationFailure).includes(path);
}

function inferRepairSuspectPaths(validationFailure: WorkingMemorySnapshot["validationFailure"]): string[] {
  const paths: string[] = [];
  if (validationFailure?.suspectFile) paths.push(validationFailure.suspectFile);
  if (validationFailure?.suspectImportPath) {
    paths.push(resolveRelatedImportPath(validationFailure.suspectFile, validationFailure.suspectImportPath));
  }
  return uniqueCompact(paths);
}

function resolveRelatedImportPath(suspectFile: string | undefined, importPath: string): string {
  if (!suspectFile || !importPath.startsWith(".")) return importPath;
  const directory = suspectFile.includes("/") ? suspectFile.slice(0, suspectFile.lastIndexOf("/")) : "";
  return normalizePath(`${directory}/${importPath}`);
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function createStrategyPathKey(strategy: string, path: string): string {
  return `${strategy}@${path}`;
}

function compactAppend(values: string[] | undefined, value: string): string[] {
  return uniqueCompact([...(values ?? []), value]).slice(-MAX_REPAIR_ATTEMPT_HISTORY);
}

function inferReadResultPath(result: ActionResult): string | null {
  if (result.action.kind !== "tool_call" || result.action.toolName !== "read_text_file" || result.ok !== true) return null;
  const output = result.output as { path?: unknown } | null;
  return typeof output?.path === "string" && output.path.length > 0 ? output.path : null;
}

function inferSearchResultPaths(result: ActionResult): string[] {
  if (result.action.kind !== "tool_call" || result.action.toolName !== "search_workspace" || result.ok !== true) return [];
  const output = result.output as { results?: Array<{ file?: unknown }> } | null;
  const paths = Array.isArray(output?.results)
    ? output.results.map((item) => item.file).filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  return uniqueCompact(paths);
}

function uniqueCompact(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

function describeRepairStrategy(
  validationFailure: WorkingMemorySnapshot["validationFailure"],
  fallback: string | undefined,
): string {
  if (validationFailure?.suspectErrorCode === "TS2322") return "synthesized TS2322 number-literal fix";
  if (validationFailure?.suspectExportName && validationFailure.suspectImportStyle) return "synthesized import/export style fix";
  if (validationFailure?.assertExpected && validationFailure.assertActual) return "synthesized assertion expected-value fix";
  return fallback ?? "workspace mutation";
}

function createPatchSignature(path: string, oldString: string, newString: string): string {
  return JSON.stringify({ tool: "patch_text_file", path, oldString, newString });
}

function createWriteSignature(path: string, content: string): string {
  return JSON.stringify({ tool: "write_text_file", path, content });
}

function inferWorkspaceMutationPath(result: ActionResult): string | null {
  if (result.action.kind !== "tool_call") return null;
  if (result.ok !== true || result.metadata?.workspaceMutation !== true) return null;

  const toolInput = result.action.toolInput as { path?: unknown } | null;
  if (typeof toolInput?.path === "string" && toolInput.path.length > 0) return toolInput.path;

  const output = result.output as { path?: unknown } | null;
  return typeof output?.path === "string" && output.path.length > 0 ? output.path : null;
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

export function applyActionResultToWorkingMemory(
  previous: WorkingMemorySnapshot,
  step: number,
  result: ActionResult,
): WorkingMemorySnapshot {
  return updateWorkingMemory(previous, step, result);
}

export async function runLoop(
  input: BrainInput,
  deps: LoopDeps,
  maxSteps = 10,
  context?: LoopContext,
): Promise<LoopState> {
  const seededHistory = [...input.history];
  const seededSteps = input.workingMemory?.step ?? seededHistory.length;
  const state: LoopState = {
    steps: seededSteps,
    history: seededHistory,
    workingMemory: createInitialWorkingMemory(input),
    lastDecision: null,
    lastResult: seededHistory.length > 0 ? seededHistory[seededHistory.length - 1] ?? null : null,
    stopReason: null,
    stopSummary: null,
  };
  input = { ...input, history: state.history, workingMemory: state.workingMemory };

  for (let i = seededSteps; i < maxSteps; i++) {
    throwIfAborted(context?.signal);
    state.steps++;

    const rawDecision = await deps.planner.decide(input, { signal: context?.signal });
    const duplicateResolution = resolveDuplicateWorkspaceMutation(rawDecision, state.history, input.availableTools);
    if (duplicateResolution.kind === "observation") {
      state.lastDecision = duplicateResolution.decision;
      state.lastResult = duplicateResolution.result;
      state.history.push(duplicateResolution.result);
      state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, duplicateResolution.result);
      input = { ...input, history: state.history, workingMemory: state.workingMemory };
      continue;
    }

    const decision = duplicateResolution.decision;
    const approved = await deps.policy.check(decision);
    state.lastDecision = approved;

    throwIfAborted(context?.signal);
    const result = await deps.dispatcher.dispatch(approved, { signal: context?.signal });
    throwIfAborted(context?.signal);
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

  finalizeDanglingCompletionCheck(state);
  return state;
}

type DuplicateWorkspaceMutationResolution =
  | { kind: "decision"; decision: BrainDecision }
  | { kind: "observation"; decision: BrainDecision; result: ActionResult };

function resolveDuplicateWorkspaceMutation(
  decision: BrainDecision,
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
): DuplicateWorkspaceMutationResolution {
  const duplicate = findDuplicateSuccessfulWorkspaceMutation(decision, history, availableTools);
  if (!duplicate) return { kind: "decision", decision };

  const hasValidationTool = availableTools.some((tool) => tool.name === "run_validation");
  const latestValidationAfterMutation = findLatestValidationAfterMutation(history, duplicate.index);

  if (hasValidationTool && !latestValidationAfterMutation) {
    return {
      kind: "decision",
      decision: {
      action: {
        kind: "tool_call",
        toolName: "run_validation",
        toolInput: { mode: duplicate.result.metadata?.validationMode ?? "all" },
      },
      reasoning: [
        decision.reasoning,
        "Duplicate workspace mutation already executed; validating instead of requesting the same approval again.",
      ].filter(Boolean).join(" "),
      },
    };
  }

  const signature = toolActionSignature(decision.action);
  if (signature && hasCompletionCheckAfterMutation(history, duplicate.index, signature)) {
    const feedback = buildCompletionGateFeedback(decision, duplicate.result, latestValidationAfterMutation);
    return {
      kind: "decision",
      decision: {
        action: latestValidationAfterMutation && validationDidFail(latestValidationAfterMutation)
          ? { kind: "fail", reason: feedback }
          : { kind: "respond", content: feedback },
        reasoning: [
          decision.reasoning,
          "Planner repeated the same workspace mutation after a completion check; returning the final completion judgment as a safety stop.",
        ].filter(Boolean).join(" "),
      },
    };
  }

  const completionCheck = buildCompletionCheckResult(decision, duplicate.result, latestValidationAfterMutation, signature);
  return {
    kind: "observation",
    decision: completionCheck.decision,
    result: completionCheck.result,
  };
}

function buildCompletionCheckResult(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
  duplicateSignature: string | null,
): { decision: BrainDecision; result: ActionResult } {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const validationFailed = latestValidation ? validationDidFail(latestValidation) : false;
  const validationSummary = latestValidation ? summarizeValidationResult(latestValidation) : null;
  const status = validationFailed ? "needs_repair" : "ready_for_final_feedback";
  const output = {
    status,
    repeatedActionPrevented: true,
    duplicateSignature,
        action: {
          toolName,
          target,
          label: labelWorkspaceActionSafe(toolName),
        },
    validation: latestValidation
      ? {
          ok: !validationFailed,
          summary: validationSummary,
        }
      : null,
    instruction: validationFailed
      ? "The repeated mutation was blocked. Use the validation result and history to choose a different repair or explain the failure; do not repeat the same tool input."
      : "The mutation and validation are complete. Decide whether the user's task is satisfied, then respond with final user-facing feedback; do not repeat the same tool input.",
  };
  const checkDecision: BrainDecision = {
    action: {
      kind: "tool_call",
      toolName: "completion_check",
      toolInput: output,
    },
    reasoning: [
      decision.reasoning,
      "Duplicate workspace mutation was converted into a completion check so the planner can make the final judgment.",
    ].filter(Boolean).join(" "),
  };

  return {
    decision: checkDecision,
    result: {
      action: checkDecision.action,
      ok: true,
      output,
      metadata: {
        category: "tool_observation",
        summary: validationFailed
          ? "Completion check: previous mutation exists, but validation failed; choose a different repair or report failure."
          : "Completion check: previous mutation and validation are complete; produce final user feedback.",
        retryable: false,
        toolName: "completion_check",
      },
    },
  };
}

function hasCompletionCheckAfterMutation(
  history: ActionResult[],
  mutationIndex: number,
  duplicateSignature: string,
): boolean {
  for (let index = history.length - 1; index > mutationIndex; index--) {
    const result = history[index];
    if (result?.action.kind !== "tool_call" || result.action.toolName !== "completion_check") continue;
    const output = result.output as { duplicateSignature?: unknown } | null;
    if (output?.duplicateSignature === duplicateSignature) return true;
  }
  return false;
}

function findLatestValidationAfterMutation(history: ActionResult[], mutationIndex: number): ActionResult | null {
  for (let index = history.length - 1; index > mutationIndex; index--) {
    const result = history[index];
    if (result?.action.kind === "tool_call" && result.action.toolName === "run_validation") {
      return result;
    }
  }
  return null;
}

type CompletionCheckPayload = {
  status: string;
  action?: {
    toolName?: string;
    target?: string;
    label?: string;
  };
  validation?: {
    ok?: boolean;
    summary?: string;
  } | null;
};

function finalizeDanglingCompletionCheck(state: LoopState): void {
  if (state.stopReason) return;
  const completionCheck = parseCompletionCheckPayload(state.lastResult);
  if (!completionCheck) return;

  const feedback = buildCompletionCheckFeedback(completionCheck);
  const failed = completionCheck.status === "needs_repair" || completionCheck.validation?.ok === false;
  const action: BrainDecision["action"] = failed
    ? { kind: "fail", reason: feedback }
    : { kind: "respond", content: feedback };
  const result: ActionResult = {
    action,
    ok: !failed,
    output: feedback,
    ...(failed ? { error: feedback } : {}),
    metadata: {
      category: failed ? "runtime_error" : "assistant_response",
      summary: feedback,
      retryable: false,
      syntheticFinalFeedback: true,
    },
  };

  state.lastDecision = {
    action,
    reasoning: "Runtime finalized a dangling completion_check so the run stops with user-facing feedback.",
  };
  state.lastResult = result;
  state.history.push(result);
  state.workingMemory = updateWorkingMemory(state.workingMemory, state.steps, result);
  state.stopReason = failed ? "fail" : "respond";
  state.stopSummary = feedback;
}

function parseCompletionCheckPayload(result: ActionResult | null): CompletionCheckPayload | null {
  if (!result || result.action.kind !== "tool_call" || result.action.toolName !== "completion_check") {
    return null;
  }
  if (!result.output || typeof result.output !== "object") return null;
  const output = result.output as {
    status?: unknown;
    action?: { toolName?: unknown; target?: unknown; label?: unknown };
    validation?: { ok?: unknown; summary?: unknown } | null;
  };
  const status = typeof output.status === "string" ? output.status : "";
  if (!status) return null;
  const action = output.action && typeof output.action === "object"
    ? {
        ...(typeof output.action.toolName === "string" ? { toolName: output.action.toolName } : {}),
        ...(typeof output.action.target === "string" ? { target: output.action.target } : {}),
        ...(typeof output.action.label === "string" ? { label: output.action.label } : {}),
      }
    : undefined;
  const validation = output.validation && typeof output.validation === "object"
    ? {
        ...(typeof output.validation.ok === "boolean" ? { ok: output.validation.ok } : {}),
        ...(typeof output.validation.summary === "string" ? { summary: output.validation.summary } : {}),
      }
    : output.validation === null
      ? null
      : undefined;
  return { status, ...(action ? { action } : {}), ...(validation !== undefined ? { validation } : {}) };
}

function buildCompletionCheckFeedback(payload: CompletionCheckPayload): string {
  const toolName = payload.action?.toolName ?? "tool";
  const label = payload.action?.label ?? labelWorkspaceActionSafe(toolName);
  const target = payload.action?.target;
  const validationSummary = summarizeCompletionValidation(payload.validation);

  if (payload.status === "needs_repair" || payload.validation?.ok === false) {
    return target
      ? `已停止重复执行：${target} 已${label}，但验证没有通过。${validationSummary} 请换一种修复方式继续。`
      : `已停止重复执行：工具动作已经执行，但验证没有通过。${validationSummary} 请换一种修复方式继续。`;
  }

  return target
    ? `已完成：${target} 已${label}。${validationSummary} 我已停止重复执行相同工具。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 我已停止重复执行相同工具。`;
}

function buildCompletionGateFeedback(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
): string {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const validationFailed = latestValidation ? validationDidFail(latestValidation) : false;
  const validationSummary = latestValidation
    ? summarizeValidationResult(latestValidation) ?? (validationFailed ? "验证未通过。" : "验证已完成。")
    : "没有检测到额外验证步骤。";
  const label = labelWorkspaceActionSafe(toolName);

  if (validationFailed) {
    return target
      ? `文件已${label}：${target}，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`
      : `工具动作已经执行，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`;
  }

  return target
    ? `已完成：${target} 已${label}。${validationSummary} 无需再次执行同一个写入动作。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 无需再次执行同一个工具动作。`;
}

function summarizeCompletionValidation(validation: CompletionCheckPayload["validation"]): string {
  const summary = validation?.summary?.trim();
  if (summary) return `验证结果：${summary}`;
  if (validation?.ok === true) return "验证已通过。";
  if (validation?.ok === false) return "验证未通过。";
  return "没有检测到额外验证步骤。";
}

function labelWorkspaceActionSafe(toolName: string): string {
  if (toolName === "delete_path") return "删除";
  if (toolName === "move_path") return "移动";
  if (toolName === "copy_path") return "复制";
  if (toolName === "patch_text_file") return "修改";
  if (toolName === "write_text_file") return "写入/更新";
  return "处理";
}

function buildDuplicateWorkspaceMutationFeedback(
  decision: BrainDecision,
  completedResult: ActionResult,
  latestValidation: ActionResult | null,
): string {
  const toolName = decision.action.toolName ?? completedResult.action.toolName ?? "tool";
  const target = inferWorkspaceActionTarget(decision.action)
    ?? inferWorkspaceActionTarget(completedResult.action)
    ?? inferOutputPath(completedResult.output);
  const actionLabel = labelWorkspaceAction(toolName);

  if (latestValidation && validationDidFail(latestValidation)) {
    const validationSummary = summarizeValidationResult(latestValidation) ?? "验证未通过。";
    return target
      ? `文件已${actionLabel}：${target}，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`
      : `工具动作已经执行，但验证未通过：${validationSummary} 我已停止重复执行同一个写入动作，请根据验证错误继续修复。`;
  }

  const validationSummary = latestValidation
    ? summarizeValidationResult(latestValidation) ?? "验证已完成。"
    : "没有检测到额外验证步骤。";

  return target
    ? `已完成：${target} 已${actionLabel}。${validationSummary} 无需再次执行同一个写入动作。`
    : `已完成：${toolName} 动作已经执行。${validationSummary} 无需再次执行同一个工具动作。`;
}

function validationDidFail(result: ActionResult): boolean {
  if (result.ok === false) return true;
  if (!result.output || typeof result.output !== "object") return false;
  return (result.output as { ok?: unknown }).ok === false;
}

function summarizeValidationResult(result: ActionResult): string | null {
  if (!result.output || typeof result.output !== "object") {
    return result.metadata?.summary ?? null;
  }

  const output = result.output as { ok?: unknown; summary?: unknown; mode?: unknown };
  const summary = typeof output.summary === "string" && output.summary.trim()
    ? output.summary.trim()
    : result.metadata?.summary;

  if (output.ok === true) return summary ?? "验证已通过。";
  if (output.ok === false) return summary ?? "验证未通过。";
  return summary ?? null;
}

function labelWorkspaceAction(toolName: string): string {
  if (toolName === "delete_path") return "删除";
  if (toolName === "move_path") return "移动";
  if (toolName === "copy_path") return "复制";
  if (toolName === "patch_text_file") return "修改";
  if (toolName === "write_text_file") return "写入/更新";
  return "处理";
}

function inferWorkspaceActionTarget(action: BrainDecision["action"]): string | null {
  if (!action.toolInput || typeof action.toolInput !== "object") return null;
  const input = action.toolInput as Record<string, unknown>;
  for (const key of ["path", "destinationPath", "sourcePath"]) {
    if (typeof input[key] === "string" && input[key].length > 0) return input[key] as string;
  }
  return null;
}

function inferOutputPath(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const value = (output as Record<string, unknown>).path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findDuplicateSuccessfulWorkspaceMutation(
  decision: BrainDecision,
  history: ActionResult[],
  availableTools: BrainInput["availableTools"],
): { index: number; result: ActionResult } | null {
  const signature = toolActionSignature(decision.action);
  if (!signature) return null;
  if (!isRepeatProtectedWorkspaceAction(decision.action, availableTools)) return null;

  for (let index = history.length - 1; index >= 0; index--) {
    const result = history[index];
    if (!result) continue;
    if (
      result.ok === true
      && isRepeatProtectedWorkspaceAction(result.action, availableTools)
      && toolActionSignature(result.action) === signature
    ) {
      return { index, result };
    }
  }

  return null;
}

function toolActionSignature(action: BrainDecision["action"]): string | null {
  if ((action.kind !== "tool_call" && action.kind !== "needs_approval") || !action.toolName) return null;
  return `${action.toolName}:${stableJson(action.toolInput ?? null)}`;
}

const REPEAT_PROTECTED_WORKSPACE_TOOLS = new Set([
  "copy_path",
  "delete_path",
  "move_path",
  "patch_text_file",
  "write_text_file",
]);

function isRepeatProtectedWorkspaceAction(
  action: BrainDecision["action"],
  availableTools: BrainInput["availableTools"],
): boolean {
  if ((action.kind !== "tool_call" && action.kind !== "needs_approval") || !action.toolName) return false;
  if (REPEAT_PROTECTED_WORKSPACE_TOOLS.has(action.toolName)) return true;

  const descriptor = availableTools.find((tool) => tool.name === action.toolName);
  return descriptor?.effects?.workspaceMutation === true;
}

function stableJson(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
  return `{${entries.join(",")}}`;
}

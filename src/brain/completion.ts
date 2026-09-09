import type { ActionResult, BrainDecision, BrainInput, TaskLoopMode } from "./types.js";
import { parseUserCommand, stripToolRoutingDirectives } from "./user-command.js";

export type CompletionStatus =
  | "ready"
  | "needs_more_evidence"
  | "needs_verification"
  | "needs_repair"
  | "needs_recovery"
  | "not_ready";

export interface CompletionJudgment {
  status: CompletionStatus;
  reason: string;
  recommendedToolName?: string;
  recommendedToolInput?: unknown;
  completionScore?: {
    score: number;
    threshold: number;
    coverage: number;
    evidence: number;
    verification: number;
    recoveryRisk: number;
    blockers: string[];
    nextStep?: string;
    ready: boolean;
  };
  recoveryPlan?: {
    kind: "retry" | "alternate_tool" | "model_replan" | "finalize";
    failedTool?: string;
    nextTool?: string;
    nextInput?: unknown;
    reason: string;
    shouldAskModel: boolean;
  };
}

export type ToolCallValueStatus = "allow" | "redirect" | "avoid";

export interface ToolCallValueJudgment {
  status: ToolCallValueStatus;
  reason: string;
  recommendedToolName?: string;
  recommendedToolInput?: unknown;
}

type TaskLoopTask = NonNullable<NonNullable<BrainInput["workingMemory"]>["taskLoop"]>["tasks"] extends Array<infer T> ? T : never;

export function judgeTaskCompletion(
  input: BrainInput,
  lastResult: ActionResult | null,
  message: string,
): CompletionJudgment {
  const judgment = judgeTaskCompletionCore(input, lastResult, message);
  return enrichCompletionJudgment(input, lastResult, judgment);
}

function judgeTaskCompletionCore(
  input: BrainInput,
  lastResult: ActionResult | null,
  message: string,
): CompletionJudgment {
  const taskLoopJudgment = judgeTaskLoopChecklist(input, lastResult, message);
  if (taskLoopJudgment) return taskLoopJudgment;

  if (!lastResult) {
    return { status: "not_ready", reason: "No runtime evidence has been collected yet." };
  }

  if (lastResult.action.kind === "respond" || lastResult.action.kind === "finish") {
    return { status: "ready", reason: "The latest action already produced user-facing feedback." };
  }

  if (lastResult.action.kind === "fail") {
    return { status: "needs_repair", reason: "The latest action failed and needs a different recovery path." };
  }

  if (lastResult.action.kind !== "tool_call") {
    return { status: "not_ready", reason: "The latest action is not usable completion evidence." };
  }

  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;

  if (!lastResult.ok) {
    const recovery = inferFailedToolRecovery(input, lastResult, message, toolName);
    if (recovery) return recovery;
    return { status: "needs_repair", reason: `The latest ${toolName ?? "tool"} result failed.` };
  }

  if (lastResult.metadata?.workspaceMutation === true) {
    if (hasTool(input, "run_validation")) {
      return {
        status: "needs_verification",
        reason: "A workspace mutation completed and validation is available.",
        recommendedToolName: "run_validation",
        recommendedToolInput: { mode: lastResult.metadata?.validationMode ?? "all" },
      };
    }
    return { status: "ready", reason: "A workspace mutation completed and no validation tool is available." };
  }

  if (toolName === "run_validation") {
    return validationDidFail(lastResult)
      ? { status: "needs_repair", reason: "Validation ran but did not pass." }
      : { status: "ready", reason: "Validation passed." };
  }

  if (toolName === "completion_check") {
    return { status: "ready", reason: "A completion check has already been produced." };
  }

  if (toolName === "web_search") {
    if ((isUrlIntent(message) || isWebArticleTask(input, message)) && hasTool(input, "web_fetch") && hasSearchResultUrl(lastResult.output)) {
      return {
        status: "needs_more_evidence",
        reason: "Search found candidate URLs; fetch the best page before final web feedback.",
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: firstSearchResultUrl(lastResult.output) },
      };
    }
    if (isWebArticleTask(input, message) && hasTool(input, "web_fetch")) {
      return {
        status: "needs_more_evidence",
        reason: "The task is an article/page reading request; search snippets are not enough without fetched body evidence.",
      };
    }
    return { status: "ready", reason: "Web search returned answerable results." };
  }

  if (toolName === "web_fetch") {
    if (hasWebBodyEvidence(lastResult.output)) {
      return { status: "ready", reason: "Fetched web page contains body evidence." };
    }
    const linkInput = linkExtractionInputFromWebFetch(lastResult);
    if (linkInput && hasTool(input, "web_extract_links")) {
      return {
        status: "needs_more_evidence",
        reason: "Fetched web page looks like navigation or partial HTML; extract candidate article links before searching again.",
        recommendedToolName: "web_extract_links",
        recommendedToolInput: linkInput,
      };
    }
    if (hasTool(input, "web_search")) {
      return {
        status: "needs_more_evidence",
        reason: "Fetched web page did not expose stable body text; searching for alternate indexed copies.",
        recommendedToolName: "web_search",
        recommendedToolInput: { query: buildContractWebSearchQuery(input, message), limit: 5 },
      };
    }
    return { status: "needs_more_evidence", reason: "Fetched web page did not expose stable body text." };
  }

  if (toolName === "web_extract_links") {
    const nextUrl = firstUnfetchedExtractedLinkUrl(lastResult.output, input.history);
    if (nextUrl && hasTool(input, "web_fetch")) {
      return {
        status: "needs_more_evidence",
        reason: "Extracted candidate article links; fetch the best candidate before final web feedback.",
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: nextUrl },
      };
    }
    if (hasTool(input, "web_search")) {
      return {
        status: "needs_recovery",
        reason: "No usable article link was extracted; search for an alternate indexed source.",
        recommendedToolName: "web_search",
        recommendedToolInput: { query: buildContractWebSearchQuery(input, message), limit: 5 },
      };
    }
    return { status: "needs_more_evidence", reason: "Extracted links did not include a usable article URL." };
  }

  if (toolName === "read_text_file" || toolName === "read_many_files") {
    return { status: "ready", reason: "Requested file content is available for final feedback." };
  }

  if (toolName === "find_files") {
    const firstPath = firstFoundFilePath(lastResult.output);
    if (firstPath && hasTool(input, "read_text_file") && !hasReadPath(input.history, firstPath)) {
      return {
        status: "needs_more_evidence",
        reason: "find_files located likely targets; read the best match before final workspace feedback.",
        recommendedToolName: "read_text_file",
        recommendedToolInput: { path: firstPath },
      };
    }
    return { status: hasFoundFiles(lastResult.output) ? "ready" : "needs_recovery", reason: hasFoundFiles(lastResult.output) ? "find_files located matching paths." : "find_files found no matching paths." };
  }

  if (toolName === "list_directory" || toolName === "inspect_project" || toolName === "search_workspace") {
    if (!isBroadWorkspaceAnalysis(message)) {
      return { status: "ready", reason: `${toolName} produced enough read-only evidence for this narrow request.` };
    }
    if (hasTool(input, "code_map")) {
      return {
        status: "needs_more_evidence",
        reason: `${toolName} is discovery evidence; a code map is still needed before broad project analysis.`,
        recommendedToolName: "code_map",
        recommendedToolInput: { maxFiles: 1200, includeTests: false },
      };
    }
    return { status: "needs_more_evidence", reason: `${toolName} is discovery evidence; key files or code map are still needed.` };
  }

  if (toolName === "record_agent_rule" || toolName === "remember_fact") {
    return { status: "ready", reason: `${toolName} persisted the reusable learning.` };
  }

  if (input.workingMemory?.taskLoop?.needsFinalAnswer === true) {
    return { status: "ready", reason: "Task-loop state says final feedback is expected." };
  }

  return { status: "not_ready", reason: "No completion signal matched the latest result." };
}

function enrichCompletionJudgment(
  input: BrainInput,
  lastResult: ActionResult | null,
  judgment: CompletionJudgment,
): CompletionJudgment {
  const completionScore = judgment.completionScore ?? scoreCompletionJudgment(input, lastResult, judgment);
  const recoveryPlan = judgment.recoveryPlan ?? inferCompletionRecoveryPlan(lastResult, judgment);
  return {
    ...judgment,
    completionScore,
    ...(recoveryPlan ? { recoveryPlan } : {}),
  };
}

function scoreCompletionJudgment(
  input: BrainInput,
  lastResult: ActionResult | null,
  judgment: CompletionJudgment,
): NonNullable<CompletionJudgment["completionScore"]> {
  const loopScore = input.workingMemory?.taskLoop?.completionScore;
  if (loopScore) {
    return {
      score: loopScore.score,
      threshold: loopScore.threshold,
      coverage: loopScore.coverage,
      evidence: loopScore.evidence,
      verification: loopScore.verification,
      recoveryRisk: loopScore.recoveryRisk,
      blockers: loopScore.blockers,
      ...(loopScore.nextStep ? { nextStep: loopScore.nextStep } : {}),
      ready: loopScore.ready && judgment.status === "ready",
    };
  }

  const ready = judgment.status === "ready";
  const statusScore = ready ? 100 : judgment.status === "needs_verification" ? 70 : judgment.status === "needs_more_evidence" ? 55 : 35;
  const evidence = scoreLatestResultEvidence(lastResult);
  const verification = scoreLatestResultVerification(lastResult, judgment);
  const recoveryRisk = scoreLatestResultRecoveryRisk(lastResult, judgment);
  const score = Math.max(0, Math.min(100, Math.round(statusScore * 0.45 + evidence * 0.3 + verification * 0.15 + recoveryRisk * 0.1)));
  const threshold = inferCompletionThreshold(input);
  const blockers = completionBlockers(judgment, lastResult);
  return {
    score,
    threshold,
    coverage: ready ? 100 : Math.min(statusScore, 80),
    evidence,
    verification,
    recoveryRisk,
    blockers,
    ...(blockers[0] ? { nextStep: blockers[0] } : {}),
    ready: ready && score >= threshold,
  };
}

function inferCompletionThreshold(input: BrainInput): number {
  const mode = input.workingMemory?.taskLoop?.mode;
  if (mode === "edit" || mode === "validation") return 88;
  if (mode === "web" || mode === "workspace") return 82;
  return 75;
}

function scoreLatestResultEvidence(lastResult: ActionResult | null): number {
  if (!lastResult) return 0;
  if (!lastResult.ok) return 10;
  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;
  if (toolName === "web_fetch") return hasWebBodyEvidence(lastResult.output) ? 100 : 45;
  if (toolName === "web_search") return hasSearchResultUrl(lastResult.output) ? 60 : 35;
  if (toolName === "read_text_file" || toolName === "read_many_files") return 100;
  if (toolName === "run_validation" || toolName === "completion_check") return validationDidFail(lastResult) ? 35 : 100;
  if (lastResult.action.kind === "respond" || lastResult.action.kind === "finish") return 100;
  return lastResult.output == null ? 40 : 70;
}

function scoreLatestResultVerification(lastResult: ActionResult | null, judgment: CompletionJudgment): number {
  if (judgment.status === "needs_verification") return 35;
  if (!lastResult) return 0;
  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;
  if (toolName === "run_validation" || toolName === "completion_check") return validationDidFail(lastResult) ? 25 : 100;
  if (judgment.status === "ready") return 85;
  return 45;
}

function scoreLatestResultRecoveryRisk(lastResult: ActionResult | null, judgment: CompletionJudgment): number {
  if (!lastResult) return 70;
  if (!lastResult.ok) return judgment.recommendedToolName ? 45 : 15;
  if (judgment.status === "needs_repair") return 30;
  if (judgment.status === "needs_recovery") return 45;
  return 100;
}

function completionBlockers(judgment: CompletionJudgment, lastResult: ActionResult | null): string[] {
  if (judgment.status === "ready") return [];
  const blockers: string[] = [judgment.status];
  if (judgment.recommendedToolName) blockers.push(`next_tool:${judgment.recommendedToolName}`);
  const failedTool = lastResult?.ok === false ? (lastResult.metadata?.toolName ?? lastResult.action.toolName) : null;
  if (failedTool) blockers.push(`failed_tool:${failedTool}`);
  return blockers;
}

function inferCompletionRecoveryPlan(
  lastResult: ActionResult | null,
  judgment: CompletionJudgment,
): CompletionJudgment["recoveryPlan"] | null {
  if (judgment.status === "ready") {
    return { kind: "finalize", reason: judgment.reason, shouldAskModel: false };
  }

  if (judgment.recommendedToolName) {
    const failedTool = lastResult?.ok === false ? (lastResult.metadata?.toolName ?? lastResult.action.toolName) : undefined;
    return {
      kind: judgment.status === "needs_recovery" ? "alternate_tool" : "retry",
      ...(failedTool ? { failedTool } : {}),
      nextTool: judgment.recommendedToolName,
      nextInput: judgment.recommendedToolInput,
      reason: judgment.reason,
      shouldAskModel: false,
    };
  }

  if (lastResult?.ok === false || judgment.status === "needs_repair" || judgment.status === "needs_recovery") {
    const failedTool = lastResult?.metadata?.toolName ?? lastResult?.action.toolName;
    return {
      kind: "model_replan",
      ...(failedTool ? { failedTool } : {}),
      reason: judgment.reason,
      shouldAskModel: true,
    };
  }

  return null;
}

function judgeTaskLoopChecklist(
  input: BrainInput,
  lastResult: ActionResult | null,
  message: string,
): CompletionJudgment | null {
  const taskLoop = input.workingMemory?.taskLoop;
  const tasks = taskLoop?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const selfCheck = taskLoop?.selfCheck;
  if (selfCheck?.status === "needs_repair") {
    const criterionId = selfCheck.missingCriteria?.[0];
    if (criterionId) {
      const recovery = recommendToolForCriterion(input, criterionId, message, lastResult, true);
      if (recovery) return recovery;
    }
    return { status: "needs_repair", reason: selfCheck.summary };
  }
  if (selfCheck?.status === "needs_evidence") {
    const criterionId = selfCheck.missingCriteria?.[0];
    if (criterionId) {
      const recovery = recommendToolForCriterion(input, criterionId, message, lastResult, false);
      if (recovery) return recovery;
    }
    return { status: "needs_more_evidence", reason: selfCheck.summary };
  }
  if (taskLoop?.finalAudit && taskLoop.finalAudit.passed !== true) {
    const criterionId = taskLoop.finalAudit.issues.find((issue) => !issue.startsWith("score:")) ?? taskLoop.finalAudit.issues[0];
    const recovery = criterionId
      ? recommendToolForCriterion(input, criterionId.replace(/^self_check:/, ""), message, lastResult, false)
      : null;
    if (recovery) return recovery;
    return {
      status: "needs_more_evidence",
      reason: taskLoop.finalAudit.summary,
      completionScore: taskLoop.completionScore,
    };
  }

  const activeTask = tasks.find((task) => task.id === taskLoop?.currentTaskId)
    ?? tasks.find((task) => task.status === "active" || task.status === "blocked")
    ?? null;
  if (!activeTask) {
    return tasks.every((task) => task.status === "done")
      ? { status: "ready", reason: "All task-loop criteria are satisfied.", completionScore: taskLoop?.completionScore }
      : null;
  }

  if (activeTask.id === "answer") {
    if (selfCheck?.status === "passed" && taskLoop?.finalAudit?.passed !== false) {
      return { status: "ready", reason: selfCheck.summary, completionScore: taskLoop?.completionScore };
    }
    if (lastResult?.ok && hasAnswerStepEvidence(input, lastResult)) {
      return { status: "ready", reason: "Task-loop answer step is active and evidence is available." };
    }
    const evidenceGap = recommendAnswerStepEvidence(input, lastResult, message);
    if (evidenceGap) return evidenceGap;
    return { status: "not_ready", reason: "Task-loop answer step is active but no successful evidence is available yet." };
  }

  const criterion = activeTask.criteria.find((item) => item.status === "pending" || item.status === "failed");
  if (!criterion) return null;

  if (activeTask.status === "blocked" || criterion.status === "failed") {
    const recovery = recommendToolForCriterion(input, criterion.id, message, lastResult, true);
    return recovery ?? {
      status: "needs_repair",
      reason: `Task-loop task "${activeTask.title}" is blocked on criterion ${criterion.id}.`,
    };
  }

  return recommendToolForCriterion(input, criterion.id, message, lastResult, false);
}

function recommendToolForCriterion(
  input: BrainInput,
  criterionId: string,
  message: string,
  lastResult: ActionResult | null,
  recovering: boolean,
): CompletionJudgment | null {
  const contractMessage = commandObjectiveMessage(input, message);
  const explicitUrl = commandUrlTarget(input, message);
  if (criterionId === "source_located") {
    if (recovering && hasTool(input, "web_search")) {
      return recommended("needs_recovery", "Task-loop source lookup is blocked; searching for an alternate accessible source.", "web_search", { query: buildContractWebSearchQuery(input, message), limit: 5 });
    }
    if (explicitUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, explicitUrl)) {
      return recommended("needs_more_evidence", "Task-loop needs the explicit URL fetched before answering.", "web_fetch", { url: explicitUrl });
    }
    if (hasTool(input, "web_search")) {
      return recommended(recovering ? "needs_recovery" : "needs_more_evidence", "Task-loop needs a web source located.", "web_search", { query: buildWebSearchQuery(contractMessage), limit: 5 });
    }
  }

  if (criterionId === "body_evidence") {
    const linkInput = lastResult?.ok ? linkExtractionInputFromWebFetch(lastResult) : null;
    if (linkInput && hasTool(input, "web_extract_links")) {
      return recommended("needs_more_evidence", "Task-loop needs candidate article links extracted from the fetched shell page.", "web_extract_links", linkInput);
    }
    const extractedUrl = firstUnfetchedExtractedLinkUrl(lastResult?.output, input.history);
    if (extractedUrl && hasTool(input, "web_fetch")) {
      return recommended("needs_more_evidence", "Task-loop needs readable page body evidence from the extracted article link.", "web_fetch", { url: extractedUrl });
    }
    const searchUrl = firstUnfetchedSearchResultUrl(input.history, lastResult);
    const fetchUrl = searchUrl ?? explicitUrl;
    if (fetchUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, fetchUrl)) {
      return recommended("needs_more_evidence", "Task-loop needs readable page body evidence from the best candidate URL.", "web_fetch", { url: fetchUrl });
    }
    if (hasTool(input, "web_search")) {
      return recommended(recovering ? "needs_recovery" : "needs_more_evidence", "Task-loop needs an alternate source because body evidence is missing.", "web_search", { query: buildContractWebSearchQuery(input, message), limit: 5 });
    }
  }

  if (criterionId === "structure_evidence") {
    if (hasTool(input, "inspect_project") && !hasRecentTool(input.history, "inspect_project")) {
      return recommended("needs_more_evidence", "Task-loop needs project structure evidence.", "inspect_project", {});
    }
    if (hasTool(input, "list_directory")) {
      return recommended(recovering ? "needs_recovery" : "needs_more_evidence", "Task-loop needs a directory listing to recover project structure.", "list_directory", { path: "." });
    }
  }

  if (criterionId === "target_evidence") {
    const path = commandPathTarget(input, message);
    if (recovering && path && hasFailedReadPath(input.history, path)) {
      if (hasTool(input, "find_files")) {
        return recommended("needs_recovery", `Reading ${path} failed; finding matching filenames can recover the correct target path.`, "find_files", { query: inferPathSearchQuery(path, message), maxResults: 20 });
      }
      if (hasTool(input, "search_workspace")) {
        return recommended("needs_recovery", `Reading ${path} failed; searching the workspace for the correct target path.`, "search_workspace", { query: path });
      }
      if (hasTool(input, "list_directory")) {
        return recommended("needs_recovery", `Reading ${path} failed; listing the parent directory to recover the correct path.`, "list_directory", { path: inferParentDirectory(path) });
      }
    }
    if (path && hasTool(input, "read_text_file") && !hasReadPath(input.history, path)) {
      return recommended("needs_more_evidence", `Task-loop needs fresh evidence from ${path} before changing it.`, "read_text_file", { path });
    }
    if (hasTool(input, "find_files") && /文件|路径|哪里|哪个|找|定位|readme|package|config|\*\./i.test(message)) {
      return recommended(recovering ? "needs_recovery" : "needs_more_evidence", "Task-loop needs the target file path located before reading or editing.", "find_files", { query: inferPathSearchQuery(path, message), maxResults: 20 });
    }
    if (hasTool(input, "search_workspace")) {
      return recommended(recovering ? "needs_recovery" : "needs_more_evidence", "Task-loop needs target evidence before editing.", "search_workspace", { query: path ?? message });
    }
  }

  if (criterionId === "key_file_evidence") {
    const path = commandPathTarget(input, message);
    if (path && hasTool(input, "read_text_file") && !hasReadPath(input.history, path)) {
      return recommended("needs_more_evidence", `Task-loop needs the requested key file ${path}.`, "read_text_file", { path });
    }
    const entrypoints = entrypointPaths(lastResult?.output);
    if (entrypoints.length > 1 && hasTool(input, "read_many_files")) {
      return recommended("needs_more_evidence", "Task-loop needs the discovered key files read together.", "read_many_files", { paths: entrypoints.slice(0, 6) });
    }
    if (hasTool(input, "code_map") && !hasRecentTool(input.history, "code_map")) {
      return recommended("needs_more_evidence", "Task-loop needs a code map before project-level analysis.", "code_map", { maxFiles: 1200, includeTests: false });
    }
  }

  if (criterionId === "validation_passed" && hasTool(input, "run_validation")) {
    return recommended("needs_verification", "Task-loop needs validation evidence before final feedback.", "run_validation", { mode: inferValidationModeFromHistory(input.history) });
  }

  return null;
}

function recommended(
  status: CompletionStatus,
  reason: string,
  recommendedToolName: string,
  recommendedToolInput: unknown,
): CompletionJudgment {
  return { status, reason, recommendedToolName, recommendedToolInput };
}

function hasAnswerStepEvidence(input: BrainInput, lastResult: ActionResult): boolean {
  if (hasAnswerEvidenceInLog(input)) return true;
  if (!lastResult.ok || lastResult.action.kind !== "tool_call") return false;
  const toolName = lastResult.metadata?.toolName ?? lastResult.action.toolName;
  const mode = input.workingMemory?.taskLoop?.mode;
  if (toolName === "completion_check") return true;
  if (mode === "web") return toolName === "web_fetch" && hasWebBodyEvidence(lastResult.output);
  if (mode === "edit" || mode === "validation") return toolName === "run_validation" || toolName === "completion_check";
  if (mode === "workspace") return toolName === "read_text_file" || toolName === "read_many_files";
  return toolName === "read_text_file" || toolName === "web_fetch" || toolName === "run_validation";
}

function hasAnswerEvidenceInLog(input: BrainInput): boolean {
  const taskLoop = input.workingMemory?.taskLoop;
  const mode = taskLoop?.mode;
  const evidenceLog = taskLoop?.evidenceLog ?? [];
  if (evidenceLog.length === 0) return false;
  if (mode === "web") return evidenceLog.some((entry) => entry.toolName === "web_fetch" && entry.kind === "web" && entry.quality === "strong");
  if (mode === "workspace") return evidenceLog.some((entry) => (entry.toolName === "read_text_file" || entry.toolName === "read_many_files") && entry.quality === "strong");
  if (mode === "edit" || mode === "validation") {
    return evidenceLog.some((entry) => (entry.toolName === "run_validation" || entry.toolName === "completion_check") && entry.quality === "strong");
  }
  return evidenceLog.some((entry) => entry.quality === "strong");
}

function recommendAnswerStepEvidence(
  input: BrainInput,
  lastResult: ActionResult | null,
  message: string,
): CompletionJudgment | null {
  const mode = input.workingMemory?.taskLoop?.mode;
  if (mode === "web") {
    const explicitUrl = commandUrlTarget(input, message);
    if (explicitUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, explicitUrl)) {
      return recommended("needs_more_evidence", "Task-loop answer step still needs readable web body evidence.", "web_fetch", { url: explicitUrl });
    }
    const candidateUrl = lastResult?.ok ? firstSearchResultUrl(lastResult.output) : null;
    if (candidateUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, candidateUrl)) {
      return recommended("needs_more_evidence", "Task-loop answer step needs the best search result fetched before answering.", "web_fetch", { url: candidateUrl });
    }
    const linkInput = lastResult?.ok ? linkExtractionInputFromWebFetch(lastResult) : null;
    if (linkInput && hasTool(input, "web_extract_links")) {
      return recommended("needs_more_evidence", "Task-loop answer step needs candidate article links extracted from the fetched shell page.", "web_extract_links", linkInput);
    }
    if (hasTool(input, "web_search")) {
      return recommended("needs_more_evidence", "Task-loop answer step needs an accessible web source with body text.", "web_search", { query: buildContractWebSearchQuery(input, message), limit: 5 });
    }
  }

  if (mode === "workspace") {
    const path = commandPathTarget(input, message) ?? firstEntrypointPath(lastResult?.output);
    if (path && hasTool(input, "read_text_file") && !hasReadPath(input.history, path)) {
      return recommended("needs_more_evidence", "Task-loop answer step needs a key file read before project feedback.", "read_text_file", { path });
    }
    const entrypoints = entrypointPaths(lastResult?.output);
    if (entrypoints.length > 1 && hasTool(input, "read_many_files")) {
      return recommended("needs_more_evidence", "Task-loop answer step needs several key files read before project feedback.", "read_many_files", { paths: entrypoints.slice(0, 6) });
    }
    if (hasTool(input, "code_map") && !hasRecentTool(input.history, "code_map")) {
      return recommended("needs_more_evidence", "Task-loop answer step needs code structure evidence before project feedback.", "code_map", { maxFiles: 1200, includeTests: false });
    }
  }

  if ((mode === "edit" || mode === "validation") && hasTool(input, "run_validation")) {
    return recommended("needs_verification", "Task-loop answer step needs validation evidence before final feedback.", "run_validation", { mode: inferValidationModeFromHistory(input.history) });
  }

  return null;
}

function inferFailedToolRecovery(
  input: BrainInput,
  failedResult: ActionResult,
  message: string,
  toolName: string | undefined,
): CompletionJudgment | null {
  if (!toolName) return null;
  if (toolName === "web_fetch") {
    const alternateUrl = hasTool(input, "web_fetch")
      ? firstUnfetchedSearchResultUrl(input.history, failedResult)
      : null;
    if (alternateUrl) {
      return {
        status: "needs_recovery",
        reason: "web_fetch failed; fetching the next unfetched search candidate is cheaper than repeating search or inspecting local files.",
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: alternateUrl },
      };
    }
  }

  if ((toolName === "web_fetch" || toolName === "web_search") && hasTool(input, "web_search")) {
    return {
      status: "needs_recovery",
      reason: `${toolName} failed; retrying through web_search may find an alternate accessible source.`,
      recommendedToolName: "web_search",
      recommendedToolInput: { query: buildContractWebSearchQuery(input, message), limit: 5 },
    };
  }

  if ((toolName === "read_text_file" || toolName === "read_many_files" || toolName === "stat_path") && hasTool(input, "search_workspace")) {
    const target = extractPathFromToolInput(failedResult.action.toolInput) ?? commandPathTarget(input, message);
    if (hasTool(input, "find_files")) {
      return {
        status: "needs_recovery",
        reason: `${toolName} failed; finding matching filenames avoids repeating a stale or duplicated path.`,
        recommendedToolName: "find_files",
        recommendedToolInput: { query: inferPathSearchQuery(target, message), maxResults: 20 },
      };
    }
    return {
      status: "needs_recovery",
      reason: `${toolName} failed; searching for the target file avoids repeating a stale or duplicated path.`,
      recommendedToolName: "search_workspace",
      recommendedToolInput: { query: inferPathSearchQuery(target, message) },
    };
  }

  if ((toolName === "read_text_file" || toolName === "read_many_files" || toolName === "list_directory" || toolName === "stat_path") && hasTool(input, "list_directory")) {
    const target = extractPathFromToolInput(failedResult.action.toolInput);
    const parent = inferParentDirectory(target);
    return {
      status: "needs_recovery",
      reason: `${toolName} failed; listing ${parent} can recover from a stale or duplicated path.`,
      recommendedToolName: "list_directory",
      recommendedToolInput: { path: parent },
    };
  }

  if (failedResult.metadata?.retryable === true) {
    const repeatedFailures = input.history
      .slice(-4)
      .filter((result) => result.ok === false && (result.metadata?.toolName ?? result.action.toolName) === toolName)
      .length;
    if (repeatedFailures < 2) {
      return {
        status: "needs_recovery",
        reason: `${toolName} failed with a retryable error; one retry is allowed before changing strategy.`,
        recommendedToolName: toolName,
        recommendedToolInput: failedResult.action.toolInput,
      };
    }
  }

  return null;
}

export function judgeToolCallValue(
  input: BrainInput,
  decision: BrainDecision,
  lastResult: ActionResult | null,
  message: string,
): ToolCallValueJudgment {
  void lastResult;
  if (decision.action.kind !== "tool_call") {
    return { status: "allow", reason: "The proposed action is not a tool call." };
  }

  const toolName = decision.action.toolName ?? "";
  const taskMode = input.workingMemory?.taskLoop?.mode;
  const explicitUrl = commandUrlTarget(input, message);
  const webIntent = taskMode === "web" || isUrlIntent(message);

  const modeLockJudgment = judgeToolAgainstTaskModeLock(input, toolName, message, lastResult, explicitUrl);
  if (modeLockJudgment) return modeLockJudgment;

  if (webIntent && isLocalWorkspaceTool(toolName)) {
    if (explicitUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, explicitUrl)) {
      return {
        status: "redirect",
        reason: `The latest user request points at a web page, so fetch ${explicitUrl} before local workspace tools.`,
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: explicitUrl },
      };
    }

    const nextSearchCandidate = firstUnfetchedSearchResultUrl(input.history, lastResult);
    if (nextSearchCandidate && hasTool(input, "web_fetch")) {
      return {
        status: "redirect",
        reason: `The latest user request is web-oriented; fetch the search result ${nextSearchCandidate} before local workspace tools.`,
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: nextSearchCandidate },
      };
    }

    if (hasTool(input, "web_search")) {
      return {
        status: "redirect",
        reason: `The latest user request is web-oriented; ${toolName} would inspect unrelated local files.`,
        recommendedToolName: "web_search",
        recommendedToolInput: { query: buildContractWebSearchQuery(input, message), limit: 5 },
      };
    }
  }

  if (!webIntent && isWorkspaceIntent(message, taskMode) && isRemoteLookupTool(toolName)) {
    return recommendWorkspaceEvidenceInstead(input, message, toolName);
  }

  if (isWorkspaceMutationTool(toolName) && !hasRecentReadEvidence(input, decision.action.toolInput)) {
    const targetPath = extractPathFromToolInput(decision.action.toolInput)
      ?? input.workingMemory?.validationFailure?.suspectFile
      ?? input.workingMemory?.repairAttempt?.suspectFile;
    if (targetPath && hasTool(input, "read_text_file")) {
      return {
        status: "redirect",
        reason: `Workspace mutation ${toolName} needs fresh file evidence before writing ${targetPath}.`,
        recommendedToolName: "read_text_file",
        recommendedToolInput: { path: targetPath },
      };
    }
    if (hasTool(input, "search_workspace")) {
      return {
        status: "redirect",
        reason: `Workspace mutation ${toolName} needs discovery evidence before editing.`,
        recommendedToolName: "search_workspace",
        recommendedToolInput: { query: targetPath ?? message },
      };
    }
  }

  const taskLoopRedirect = judgeToolAgainstActiveTaskLoopCriterion(input, toolName, lastResult, message);
  if (taskLoopRedirect) return taskLoopRedirect;

  return { status: "allow", reason: "The proposed tool matches the current task-loop state." };
}

function judgeToolAgainstActiveTaskLoopCriterion(
  input: BrainInput,
  proposedToolName: string,
  lastResult: ActionResult | null,
  message: string,
): ToolCallValueJudgment | null {
  const taskLoop = input.workingMemory?.taskLoop;
  const tasks = taskLoop?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const activeTask = tasks.find((task) => task.id === taskLoop?.currentTaskId)
    ?? tasks.find((task) => task.status === "active")
    ?? null;
  if (!activeTask || activeTask.id === "answer" || activeTask.status === "blocked") return null;

  const criterion = activeTask.criteria.find((item) => item.status === "pending");
  if (!criterion || proposedToolSatisfiesCriterion(proposedToolName, criterion.id)) return null;

  const recommendation = recommendToolForCriterion(input, criterion.id, message, lastResult, false);
  if (!recommendation?.recommendedToolName || recommendation.recommendedToolName === proposedToolName) return null;

  return {
    status: "redirect",
    reason: `Current task-loop criterion ${criterion.id} is not served by ${proposedToolName}; using ${recommendation.recommendedToolName} first.`,
    recommendedToolName: recommendation.recommendedToolName,
    recommendedToolInput: recommendation.recommendedToolInput,
  };
}

function proposedToolSatisfiesCriterion(toolName: string, criterionId: string): boolean {
  const allowed: Record<string, string[]> = {
    source_located: ["web_fetch", "web_search", "web_extract_links"],
    body_evidence: ["web_fetch", "web_search", "web_extract_links"],
    structure_evidence: ["inspect_project", "list_directory", "find_files", "search_workspace", "code_map"],
    target_evidence: ["read_text_file", "read_many_files", "find_files", "search_workspace", "inspect_project", "list_directory", "code_map"],
    key_file_evidence: ["read_text_file", "read_many_files", "find_files", "code_map", "symbol_search", "dependency_graph"],
    workspace_mutated: ["copy_path", "delete_path", "move_path", "patch_text_file", "terminal_command", "write_text_file"],
    validation_passed: ["run_validation", "completion_check"],
    request_understood: [],
    final_feedback: [],
  };
  return allowed[criterionId]?.includes(toolName) ?? true;
}

function judgeToolAgainstTaskModeLock(
  input: BrainInput,
  proposedToolName: string,
  message: string,
  lastResult: ActionResult | null,
  explicitUrl: string | null,
): ToolCallValueJudgment | null {
  const mode = input.workingMemory?.taskLoop?.mode;
  if (!mode) return null;

  if (mode === "web" && isWorkspaceBoundTool(proposedToolName)) {
    if (explicitUrl && hasTool(input, "web_fetch") && !hasFetchedUrl(input.history, explicitUrl)) {
      return {
        status: "redirect",
        reason: `Task-loop mode is locked to web; fetch ${explicitUrl} before any workspace tool.`,
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: explicitUrl },
      };
    }

    const nextSearchCandidate = firstUnfetchedSearchResultUrl(input.history, lastResult);
    if (nextSearchCandidate && hasTool(input, "web_fetch")) {
      return {
        status: "redirect",
        reason: `Task-loop mode is locked to web; fetch ${nextSearchCandidate} before any workspace tool.`,
        recommendedToolName: "web_fetch",
        recommendedToolInput: { url: nextSearchCandidate },
      };
    }

    if (hasTool(input, "web_search")) {
      return {
        status: "redirect",
        reason: `Task-loop mode is locked to web; ${proposedToolName} would inspect or mutate the local workspace.`,
        recommendedToolName: "web_search",
        recommendedToolInput: { query: buildContractWebSearchQuery(input, message), limit: 5 },
      };
    }

    return {
      status: "avoid",
      reason: `Task-loop mode is locked to web; ${proposedToolName} is a workspace/tooling action and web tools are not available in this run.`,
    };
  }

  if ((mode === "workspace" || mode === "edit" || mode === "validation") && isRemoteLookupTool(proposedToolName) && !isUrlIntent(message)) {
    return recommendWorkspaceEvidenceInstead(input, message, proposedToolName);
  }

  return null;
}

function recommendWorkspaceEvidenceInstead(
  input: BrainInput,
  message: string,
  proposedToolName: string,
): ToolCallValueJudgment {
  const path = commandPathTarget(input, message);
  if (path && hasTool(input, "read_text_file") && !hasReadPath(input.history, path)) {
    return {
      status: "redirect",
      reason: `Workspace route lock: ${proposedToolName} would leave the local file task; reading ${path} first.`,
      recommendedToolName: "read_text_file",
      recommendedToolInput: { path },
    };
  }

  const query = buildContractWorkspaceEvidenceQuery(input, message);
  if (hasTool(input, "find_files")) {
    return {
      status: "redirect",
      reason: `Workspace route lock: ${proposedToolName} is not allowed without explicit web intent; locating relevant workspace files first.`,
      recommendedToolName: "find_files",
      recommendedToolInput: { query, includeDirectories: true, maxResults: 40 },
    };
  }

  if (hasTool(input, "search_workspace")) {
    return {
      status: "redirect",
      reason: `Workspace route lock: ${proposedToolName} is not allowed without explicit web intent; searching the workspace first.`,
      recommendedToolName: "search_workspace",
      recommendedToolInput: { query },
    };
  }

  if (hasTool(input, "inspect_project")) {
    return {
      status: "redirect",
      reason: `Workspace route lock: ${proposedToolName} is not allowed without explicit web intent; inspecting the workspace first.`,
      recommendedToolName: "inspect_project",
      recommendedToolInput: {},
    };
  }

  return {
    status: "avoid",
    reason: `Workspace route lock: ${proposedToolName} would leave the local task, and no workspace evidence tool is available.`,
  };
}

function hasTool(input: BrainInput, name: string): boolean {
  return input.availableTools.some((tool) => tool.name === name);
}

function validationDidFail(result: ActionResult): boolean {
  if (!result.output || typeof result.output !== "object" || Array.isArray(result.output)) return false;
  return (result.output as { ok?: unknown }).ok === false;
}

function isUrlIntent(message: string): boolean {
  const text = message.toLowerCase();
  if (/https?:\/\//i.test(text)) return true;
  if (/网页|网址|链接|文章|正文|抓取|联网|上网|网上|网络|官网|新闻|资料|文档|最新|最近|当前|发布|fetch|url|web|online|latest|current/.test(text)) {
    return true;
  }
  const searchIntent = /搜|搜索|查一下|查询|查找|检索|look up|search|find/.test(text);
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory/.test(text);
  return searchIntent && !localIntent;
}

function isBroadWorkspaceAnalysis(message: string): boolean {
  return /项目|工程|代码库|仓库|整体|结构|分析|看一下|梳理|project|repo|codebase|analy[sz]e/i.test(message);
}

function isWorkspaceIntent(message: string, taskMode?: TaskLoopMode): boolean {
  return taskMode === "workspace"
    || taskMode === "edit"
    || taskMode === "validation"
    || isBroadWorkspaceAnalysis(message)
    || isLocalFileTaskIntent(message);
}

function isLocalFileTaskIntent(message: string): boolean {
  const text = message.toLowerCase();
  const localIntent = /工作区|本地|目录|文件|项目|代码|工程|仓库|workspace|local|repo|codebase|file|directory/.test(text);
  const fileActionIntent = /翻译|总结|改写|润色|读取|查看|分析|处理|保存|修改|编辑|translate|summari[sz]e|rewrite|polish/.test(text);
  return localIntent && fileActionIntent;
}

function isLocalWorkspaceTool(toolName: string): boolean {
  return [
    "code_map",
    "collect_diagnostics",
    "dependency_graph",
    "git_diff",
    "git_status",
    "inspect_project",
    "list_directory",
    "find_files",
    "read_text_file",
    "read_many_files",
    "run_validation",
    "run_terminal_command",
    "search_workspace",
    "stat_path",
    "symbol_search",
  ].includes(toolName);
}

function isWorkspaceBoundTool(toolName: string): boolean {
  return isLocalWorkspaceTool(toolName)
    || isWorkspaceMutationTool(toolName)
    || toolName === "completion_check";
}

function isRemoteLookupTool(toolName: string): boolean {
  return toolName === "web_fetch"
    || toolName === "web_search"
    || toolName.startsWith("github_")
    || toolName.includes("web");
}

function isWorkspaceMutationTool(toolName: string): boolean {
  return [
    "copy_path",
    "delete_path",
    "move_path",
    "patch_text_file",
    "terminal_command",
    "run_terminal_command",
    "write_text_file",
  ].includes(toolName);
}

function hasRecentReadEvidence(input: BrainInput, toolInput: unknown): boolean {
  const targetPath = normalizePath(extractPathFromToolInput(toolInput));
  const recentHistory = input.history.slice(-8);
  return recentHistory.some((result) => {
    if (!result.ok || result.action.kind !== "tool_call") return false;
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    if (!isReadEvidenceTool(toolName ?? "")) return false;
    if (!targetPath) return true;
    return [result.action.toolInput, result.output].some((value) => {
      const observedPath = normalizePath(extractPathFromToolInput(value));
      return observedPath === targetPath || observedPath.endsWith(`/${targetPath}`) || targetPath.endsWith(`/${observedPath}`);
    });
  });
}

function isReadEvidenceTool(toolName: string): boolean {
  return [
    "code_map",
    "inspect_project",
    "list_directory",
    "find_files",
    "read_text_file",
    "read_many_files",
    "search_workspace",
  ].includes(toolName);
}

function extractPathFromToolInput(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "target", "targetPath", "cwd"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function normalizePath(path: string | null): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").toLowerCase();
}

function extractFirstHttpUrl(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s"'<>，。！？、]+/i);
  return match?.[0] ?? null;
}

function hasFetchedUrl(history: ActionResult[], url: string): boolean {
  return history.some((result) => {
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    if (toolName !== "web_fetch" || result.action.kind !== "tool_call") return false;
    const inputUrl = extractPathLikeUrl(result.action.toolInput);
    const outputUrl = extractPathLikeUrl(result.output);
    return inputUrl === url || outputUrl === url;
  });
}

function extractPathLikeUrl(value: unknown): string | null {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "href", "finalUrl"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return null;
}

function buildWebSearchQuery(message: string): string {
  const parsed = parseUserCommand(message);
  if (parsed.normalizedSearchQuery) return parsed.normalizedSearchQuery;
  const withoutUrls = message.replace(/https?:\/\/[^\s"'<>，。！？、]+/gi, " ");
  const cleaned = withoutUrls
    .replace(/联网搜索|网页搜索|搜索|搜一下|查一下|看一下|帮我|能不能|可以|吗/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || message.trim() || "latest web information";
}

function buildWorkspaceEvidenceQuery(message: string): string {
  const path = extractPathFromMessage(message);
  if (path) return inferPathSearchQuery(path, message);
  const cleaned = stripToolRoutingDirectives(message)
    .replace(/翻译|总结|改写|润色|读取|查看|看一下|一下|分析|处理|工作区|本地|目录|文件|项目|代码|工程|仓库|帮我|请/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "*";
}

function buildContractWebSearchQuery(input: BrainInput, message: string): string {
  return buildWebSearchQuery(commandObjectiveMessage(input, message));
}

function buildContractWorkspaceEvidenceQuery(input: BrainInput, message: string): string {
  const path = commandPathTarget(input, message);
  if (path) return inferPathSearchQuery(path, commandObjectiveMessage(input, message));
  return buildWorkspaceEvidenceQuery(commandObjectiveMessage(input, message));
}

function commandObjectiveMessage(input: BrainInput, message: string): string {
  return input.workingMemory?.taskLoop?.userCommand?.commandContract?.objective
    ?? input.workingMemory?.taskLoop?.userCommand?.objective
    ?? input.workingMemory?.taskLoop?.objective
    ?? message;
}

function commandUrlTarget(input: BrainInput, message: string): string | null {
  const contractUrl = input.workingMemory?.taskLoop?.userCommand?.commandContract?.targets.urls[0]
    ?? input.workingMemory?.taskLoop?.userCommand?.explicitUrls?.[0];
  return contractUrl ?? extractFirstHttpUrl(message) ?? extractFirstHttpUrl(commandObjectiveMessage(input, message));
}

function commandPathTarget(input: BrainInput, message: string): string | null {
  const contractPath = input.workingMemory?.taskLoop?.userCommand?.commandContract?.targets.paths[0];
  if (contractPath) return contractPath;
  return extractPathFromMessage(message) ?? extractPathFromMessage(commandObjectiveMessage(input, message));
}

function inferParentDirectory(path: string | null): string {
  if (!path) return ".";
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
  if (!normalized || normalized === ".") return ".";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return ".";
  return normalized.slice(0, index);
}

function inferPathSearchQuery(path: string | null, message: string): string {
  const normalized = (path ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "").trim();
  if (normalized) {
    const basename = normalized.split("/").filter(Boolean).pop();
    if (basename && /\.[a-z0-9]{1,12}$/i.test(basename)) return basename;
    return normalized;
  }
  return extractPathFromMessage(message) ?? message.trim();
}

function hasSearchResultUrl(output: unknown): boolean {
  return firstSearchResultUrl(output) !== null;
}

function isWebArticleTask(input: BrainInput, message: string): boolean {
  const taskKind = input.workingMemory?.taskLoop?.taskKind ?? input.workingMemory?.taskLoop?.userCommand?.taskKind;
  if (taskKind === "web_article") return true;
  const text = message.toLowerCase();
  return /https?:\/\/|网页|网址|链接|正文|文章|新闻|博客|抓取|读取网页|看这个网页|web\s*page|article|url|link/.test(text);
}

function firstSearchResultUrl(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function firstUnfetchedSearchResultUrl(history: ActionResult[], lastResult: ActionResult | null): string | null {
  const searchResults = [
    ...(lastResult ? [lastResult] : []),
    ...[...history].reverse(),
  ];
  for (const result of searchResults) {
    if (!result.ok || result.action.kind !== "tool_call") continue;
    if ((result.metadata?.toolName ?? result.action.toolName) !== "web_search") continue;
    for (const url of searchResultUrls(result.output)) {
      if (!hasFetchedUrl(history, url)) return url;
    }
  }
  return null;
}

function linkExtractionInputFromWebFetch(result: ActionResult): unknown | null {
  if (result.action.kind !== "tool_call") return null;
  const toolName = result.metadata?.toolName ?? result.action.toolName;
  if (toolName !== "web_fetch") return null;
  if (!result.output || typeof result.output !== "object" || Array.isArray(result.output)) return null;
  const record = result.output as { htmlPreview?: unknown; html?: unknown; url?: unknown; finalUrl?: unknown };
  const html = typeof record.htmlPreview === "string" && record.htmlPreview.trim().length > 40
    ? record.htmlPreview
    : typeof record.html === "string" && record.html.trim().length > 40
      ? record.html
      : null;
  if (!html) return null;
  const baseUrl = typeof record.finalUrl === "string"
    ? record.finalUrl
    : typeof record.url === "string"
      ? record.url
      : extractPathLikeUrl(result.action.toolInput);
  return {
    html,
    ...(baseUrl ? { baseUrl } : {}),
    limit: 20,
  };
}

function firstExtractedLinkUrl(output: unknown): string | null {
  return extractedLinkUrls(output)[0] ?? null;
}

function firstUnfetchedExtractedLinkUrl(output: unknown, history: ActionResult[]): string | null {
  return extractedLinkUrls(output).find((url) => !hasFetchedUrl(history, url)) ?? null;
}

function extractedLinkUrls(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const links = (output as { links?: unknown }).links;
  if (!Array.isArray(links)) return [];
  const urls: string[] = [];
  for (const item of links) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

function searchResultUrls(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const urls: string[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

function hasFoundFiles(output: unknown): boolean {
  return firstFoundFilePath(output) !== null;
}

function firstFoundFilePath(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { path?: unknown; kind?: unknown };
    if (record.kind === "directory") continue;
    if (typeof record.path === "string" && record.path.trim()) return record.path.trim();
  }
  return null;
}

function firstEntrypointPath(output: unknown): string | null {
  return entrypointPaths(output)[0] ?? null;
}

function entrypointPaths(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const record = output as { entrypoints?: unknown; files?: unknown };
  const candidates = Array.isArray(record.entrypoints)
    ? record.entrypoints
    : Array.isArray(record.files)
      ? record.files
      : [];
  const paths: string[] = [];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      paths.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { path?: unknown; file?: unknown };
    if (typeof record.path === "string" && record.path.trim()) paths.push(record.path.trim());
    if (typeof record.file === "string" && record.file.trim()) paths.push(record.file.trim());
  }
  return Array.from(new Set(paths)).slice(0, 10);
}

function hasRecentTool(history: ActionResult[], toolName: string): boolean {
  return history.slice(-8).some((result) => result.action.kind === "tool_call" && (result.metadata?.toolName ?? result.action.toolName) === toolName);
}

function hasReadPath(history: ActionResult[], path: string): boolean {
  const target = normalizePath(path);
  return history.slice(-12).some((result) => {
    if (!result.ok || result.action.kind !== "tool_call") return false;
    const toolName = result.metadata?.toolName ?? result.action.toolName;
    if (toolName !== "read_text_file" && toolName !== "read_many_files") return false;
    const inputPath = normalizePath(extractPathFromToolInput(result.action.toolInput));
    const outputPath = normalizePath(extractPathFromToolInput(result.output));
    return inputPath === target
      || outputPath === target
      || inputPath.endsWith(`/${target}`)
      || outputPath.endsWith(`/${target}`)
      || readManyOutputPaths(result.output).some((path) => path === target || path.endsWith(`/${target}`) || target.endsWith(`/${path}`));
  });
}

function readManyOutputPaths(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const files = (output as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => !file || typeof file !== "object" || Array.isArray(file) ? "" : normalizePath(extractPathFromToolInput(file)))
    .filter(Boolean);
}

function hasFailedReadPath(history: ActionResult[], path: string): boolean {
  const target = normalizePath(path);
  return history.slice(-8).some((result) => {
    if (result.ok || result.action.kind !== "tool_call") return false;
    if ((result.metadata?.toolName ?? result.action.toolName) !== "read_text_file") return false;
    const inputPath = normalizePath(extractPathFromToolInput(result.action.toolInput));
    return inputPath === target || inputPath.endsWith(`/${target}`) || target.endsWith(`/${inputPath}`);
  });
}

function extractPathFromMessage(message: string): string | null {
  const quoted = message.match(/["'`“”‘’]([^"'`“”‘’]+\.[a-z0-9]{1,12})["'`“”‘’]/i);
  if (quoted?.[1]) return quoted[1].trim();
  const windowsPath = message.match(/[a-z]:[\\/][^\s"'<>，。！？、]+/i);
  if (windowsPath?.[0]) return windowsPath[0].trim();
  const portablePath = message.match(/(?:\.\/|\.\.\/|[a-z0-9_.-]+\/)[^\s"'<>，。！？、]+\.[a-z0-9]{1,12}/i);
  if (portablePath?.[0]) return portablePath[0].trim();
  const filename = message.match(/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|dart|java|go|rs|md|json|yaml|yml|toml|css|html|vue|svelte)\b/i);
  return filename?.[0] ?? null;
}

function inferValidationModeFromHistory(history: ActionResult[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const result = history[index];
    if (!result || result.action.kind !== "tool_call") continue;
    if (result.metadata?.workspaceMutation === true && result.metadata.validationMode) {
      return result.metadata.validationMode;
    }
  }
  return "all";
}

function hasWebBodyEvidence(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as {
    text?: unknown;
    content?: unknown;
    articleCandidates?: Array<{ text?: unknown }>;
    extraction?: { quality?: { status?: unknown } };
  };
  const quality = record.extraction?.quality?.status;
  if (quality === "strong") return true;
  if (quality === "weak" || quality === "failed") return false;
  if (isReadableArticleText(record.text, 80)) return true;
  if (isReadableArticleText(record.content, 80)) return true;
  if (Array.isArray(record.articleCandidates)) {
    return record.articleCandidates.some((candidate) => {
      return isReadableArticleText(candidate.text, 80);
    });
  }
  return false;
}

function isReadableArticleText(value: unknown, minLength: number): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < minLength) return false;
  const boilerplateHits = [
    /下载.*客户端/,
    /扫码|二维码|APP|广告|举报|评论|分享/,
    /关注.*公众号/,
    /copyright|版权所有|ICP备案/i,
  ].filter((pattern) => pattern.test(text)).length;
  const paragraphLike = text.split(/\n+/).filter((line) => line.trim().length >= 20).length;
  return boilerplateHits < 2 || paragraphLike >= 2;
}

import type { ContextBundle } from "../context/types.js";
import type { Turn } from "../core/types.js";
import type { ToolDescriptor, ValidationModeHint } from "../tools/types.js";
import type { LlmTokenUsage } from "./usage.js";

export interface BrainInput {
  // 本轮决策可见的上下文快照，包含用户输入、压缩记忆和运行时注入内容。
  context: ContextBundle;
  runId: string;
  priorTurns: Turn[];
  history: ActionResult[];
  // workingMemory 是循环内部状态，不等同于长期记忆；主要用于 repair/phase 续跑。
  workingMemory?: WorkingMemorySnapshot;
  availableTools: ToolDescriptor[];
}

export type BrainActionKind = "respond" | "tool_call" | "finish" | "fail" | "needs_approval";

export type PlannerPhase = "investigate" | "edit" | "validate" | "summarize";
export type TaskLoopMode = "chat" | "web" | "workspace" | "edit" | "validation";
export type TaskIntentKind =
  | "chat"
  | "web_search"
  | "web_article"
  | "workspace_overview"
  | "file_read"
  | "file_transform"
  | "code_analysis"
  | "edit"
  | "debug"
  | "validation"
  | "release";
export type TaskLoopEvidenceKind = "web" | "workspace" | "file" | "code" | "validation" | "terminal" | "unknown";
export type TaskLoopEvidenceQuality = "strong" | "weak" | "failed";
export type TaskLoopPlanStatus = "pending" | "active" | "done" | "blocked";
export type TaskLoopCriterionStatus = "pending" | "satisfied" | "failed";
export type TaskLoopSelfCheckStatus = "pending" | "passed" | "needs_evidence" | "needs_repair";

export interface BrainAction {
  kind: BrainActionKind;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  reason?: string;
  approvalId?: string;
  capability?: string;
}

export interface BrainDecision {
  action: BrainAction;
  reasoning?: string;
  usage?: LlmTokenUsage;
}

export interface WorkingMemorySnapshot {
  step: number;
  phase?: PlannerPhase;
  taskLoop?: {
    objective: string;
    userCommand?: {
      raw: string;
      objective: string;
      normalizedSearchQuery?: string;
      explicitUrls?: string[];
      toolDirectives?: string[];
      skillDirectives?: string[];
      outputDirectives?: string[];
      constraints?: string[];
      modeHint?: TaskLoopMode | null;
      taskKind?: TaskIntentKind;
      commandContract?: {
        version: "shiguang.command.v1";
        original: string;
        objective: string;
        route: TaskLoopMode;
        taskKind: TaskIntentKind;
        targets: {
          urls: string[];
          paths: string[];
        };
        directives: {
          tools: string[];
          skills: string[];
          output: string[];
          constraints: string[];
        };
        immutable: true;
      };
    };
    mode: TaskLoopMode;
    taskKind?: TaskIntentKind;
    evidenceCount: number;
    completionGateCount: number;
    currentStep?: string;
    plan?: Array<{
      id: string;
      title: string;
      status: TaskLoopPlanStatus;
    }>;
    currentTaskId?: string;
    tasks?: Array<{
      id: string;
      title: string;
      status: TaskLoopPlanStatus;
      dependsOn?: string[];
      criteria: Array<{
        id: string;
        description: string;
        status: TaskLoopCriterionStatus;
        evidence?: string;
      }>;
      toolHints?: string[];
      attempts: number;
      lastSummary?: string;
    }>;
    lastEvidenceKind?: TaskLoopEvidenceKind;
    lastEvidenceTool?: string;
    lastEvidenceTarget?: string;
    lastProgressSummary?: string;
    evidenceLog?: Array<{
      step: number;
      toolName: string;
      kind: TaskLoopEvidenceKind;
      quality: TaskLoopEvidenceQuality;
      valueScore?: number;
      advancesTask?: boolean;
      taskAlignment?: "aligned" | "weak" | "misaligned";
      target?: string;
      summary: string;
    }>;
    selfCheck?: {
      status: TaskLoopSelfCheckStatus;
      summary: string;
      checkedAtStep: number;
      missingCriteria?: string[];
      latestEvidenceQuality?: TaskLoopEvidenceQuality;
    };
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
    finalAudit?: {
      passed: boolean;
      summary: string;
      issues: string[];
      evidenceScore: number;
      completionScore: number;
      checkedAtStep: number;
    };
    needsFinalAnswer?: boolean;
  };
  lastActionKind: BrainActionKind | null;
  lastToolName?: string;
  lastObservation?: {
    category: ActionResultCategory;
    summary: string;
  };
  validationFailure?: {
    // 最近一次 validation 失败的结构化摘要，供 planner/model 做定向修复。
    mode: ValidationModeHint;
    failingCommands: string[];
    summary: string;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    suspectFile?: string;
    suspectLine?: number;
    suspectColumn?: number;
    suspectErrorCode?: string;
    suspectImportPath?: string;
    suspectImportStyle?: string;
    suspectExportName?: string;
    failingTestName?: string;
    assertExpected?: string;
    assertActual?: string;
    assertDiffSummary?: string;
  };
  repairAttempt?: {
    // 记录同一 suspect 上已经尝试过哪些修复路径，避免死循环重复改同一补丁。
    suspectFile: string;
    validationFailureCount: number;
    editAttemptCount: number;
    exhausted: boolean;
    lastStrategy?: string;
    lastPatchSignature?: string;
    triedStrategies?: string[];
    triedSuspectPaths?: string[];
    triedStrategyPaths?: string[];
    exhaustedSearchQuery?: string;
    exhaustedSearchCandidatePaths?: string[];
    exhaustedReadCandidatePaths?: string[];
  };
  retryableToolErrors?: {
    // 对同一工具的连续可重试失败做计数，交给 evaluator 决定是否停止。
    toolName: string;
    count: number;
  };
}

export interface ActionResult {
  action: BrainAction;
  ok: boolean;
  output: unknown;
  error?: string;
  metadata?: ActionResultMetadata;
}

export type ActionResultCategory =
  | "assistant_response"
  | "agent_finish"
  | "tool_observation"
  | "tool_error"
  | "runtime_error";

export type ToolErrorKind =
  | "invalid_input"
  | "permission_denied"
  | "auth_required"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "not_found"
  | "conflict"
  | "tool_missing"
  | "unknown";

export interface ActionResultMetadata {
  category: ActionResultCategory;
  summary: string;
  retryable?: boolean;
  toolName?: string;
  toolCallId?: string;
  errorType?: string;
  errorKind?: ToolErrorKind;
  workspaceMutation?: boolean;
  validationMode?: ValidationModeHint;
  syntheticFinalFeedback?: boolean;
}

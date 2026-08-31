import { type CSSProperties, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopSessions, useRunEvents } from "./hooks/useDesktopSessions";
import { getDesktopBridge, getDesktopBridgeErrorMessage, requireDesktopBridge } from "./bridge";
import type { DesktopSession, DesktopRun, DesktopConversationEntry, DesktopEvent, DesktopSettings, DesktopApproval, DesktopArtifact, DesktopProviderConnectionResult, DesktopAttachment, DesktopTokenUsage, DesktopSessionLlmSettings, ToolApprovalMode } from "./bridge";

type PillVariant = "progress" | "safe" | "auto" | "todo";
type BannerVariant = "info" | "warn" | "danger" | "success";
type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
type ProviderAuthMode = "api_key" | "none";
type ProviderDraft = {
  key: string;
  type: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseURL: string;
  apiKey: string;
  apiKeyMasked: string;
  hasStoredApiKey: boolean;
  apiKeyEnv: string;
  model: string;
  maxTokens: string;
};

type ProviderModelOption = {
  label: string;
  value: string;
  hint: string;
};

type ComposerModelOption = {
  label: string;
  value: string;
  hint: string;
  provider: string;
  model: string;
  maxTokens?: number;
};

type SignalTone = "neutral" | "success" | "warn" | "danger" | "accent";
type MainSurface = "home" | "running" | "approval";

type RunActivitySummary = {
  label: string;
  detail: string;
  tone: SignalTone;
  ageLabel: string | null;
  stalled: boolean;
  stalledDetail: string | null;
};

type RunPhaseStep = {
  key: "boot" | "plan" | "tool" | "reply";
  label: string;
  status: "done" | "active" | "idle" | "warn";
};

type RunPhaseSummary = {
  label: string;
  detail: string;
  tone: SignalTone;
  steps: RunPhaseStep[];
  elapsedLabel: string | null;
  silenceLabel: string | null;
  latestEventLabel: string | null;
};

type RunActivityTranscript = {
  id: string;
  runId: string;
  title: string;
  detail: string;
  tone: SignalTone;
  phase: string;
  phaseLabel: string;
  toolName: string | null;
  toolLabel: string;
  createdAt: string;
  meta: string[];
  active: boolean;
};

type RunFailureInsight = {
  title: string;
  summary: string;
  cause: string;
  nextStep: string;
  tone: SignalTone;
  suspectFile?: string;
  failingCommand?: string;
  lastAttempt?: string;
  evidence?: string[];
  evidenceBlockTitle?: string;
  evidenceBlockContent?: string;
};

const CODEX_PROVIDER_HINT = "先做 Hermes 风格 API provider registry：Codex 目前走 OpenAI API 模式，不走 CLI/OAuth 登录态；其他兼容 Chat Completions 的 provider 也一样接。";

const SESSION_PIN_STORAGE_KEY = "shiguang:pinned-sessions";
const SESSION_DRAFT_STORAGE_KEY = "shiguang:session-drafts";
const MAX_TIMELINE_SOURCE_EVENTS = 320;
const MAX_TIMELINE_RENDER_ITEMS = 120;
const MAX_CHAT_ACTIVITY_ITEMS = 36;
const RUN_REFRESH_MIN_INTERVAL_MS = 1500;

const PROVIDER_PRESETS: ProviderDraft[] = [
  { key: "deepseek", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.deepseek.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash", maxTokens: "4096" },
  { key: "openai", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "codex-api", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "openrouter", type: "openai-compatible", authMode: "api_key", baseURL: "https://openrouter.ai/api/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-5", maxTokens: "4096" },
  { key: "anthropic", type: "anthropic", authMode: "api_key", baseURL: "https://api.anthropic.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-3-5-sonnet-latest", maxTokens: "4096" },
  { key: "gemini", type: "gemini", authMode: "api_key", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", maxTokens: "4096" },
  { key: "ollama", type: "openai-compatible", authMode: "none", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "", model: "qwen2.5-coder:14b", maxTokens: "4096" },
];

const DEEPSEEK_MODEL_OPTIONS: ProviderModelOption[] = [
  { label: "Flash", value: "deepseek-v4-flash", hint: "默认推荐，速度/成本更适合日常 Agent" },
  { label: "Pro", value: "deepseek-v4-pro", hint: "更强，适合复杂工程和长任务" },
  { label: "Legacy Chat", value: "deepseek-chat", hint: "旧兼容名，建议逐步切到 Flash" },
  { label: "Legacy Reasoner", value: "deepseek-reasoner", hint: "旧思考兼容名，建议逐步切到 Pro/Flash" },
];

function findProviderPreset(key: string): ProviderDraft | null {
  return PROVIDER_PRESETS.find((preset) => preset.key === key) ?? null;
}

function isDeepSeekProvider(key: string, draft: ProviderDraft): boolean {
  return `${key} ${draft.baseURL}`.toLowerCase().includes("deepseek");
}

function modelOptionsForProvider(key: string, draft: ProviderDraft): ProviderModelOption[] {
  if (isDeepSeekProvider(key, draft)) return DEEPSEEK_MODEL_OPTIONS;
  return [];
}

function composerModelValue(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function buildComposerModelOptions(settings: DesktopSettings, activeProvider: string, activeModel: string): ComposerModelOption[] {
  const options: ComposerModelOption[] = [];
  const seen = new Set<string>();

  const pushOption = (provider: string, model: string, label?: string, hint?: string, maxTokens?: number) => {
    const cleanProvider = provider.trim();
    const cleanModel = model.trim();
    if (!cleanProvider || !cleanModel) return;
    const value = composerModelValue(cleanProvider, cleanModel);
    if (seen.has(value)) return;
    seen.add(value);
    options.push({
      provider: cleanProvider,
      model: cleanModel,
      value,
      label: label ?? `${cleanProvider} · ${cleanModel}`,
      hint: hint ?? `当前会话使用 ${cleanProvider} / ${cleanModel}`,
      ...(typeof maxTokens === "number" ? { maxTokens } : {}),
    });
  };

  for (const [provider, rawProvider] of Object.entries(settings.providers ?? {})) {
    const draft = providerDraftFromSettings(settings, provider);
    const presetOptions = modelOptionsForProvider(provider, draft);
    if (presetOptions.length > 0) {
      for (const option of presetOptions) {
        pushOption(provider, option.value, `${provider} · ${option.label}`, option.hint, rawProvider.maxTokens);
      }
    }
    pushOption(provider, draft.model || settings.llm.model || "", undefined, undefined, rawProvider.maxTokens);
  }

  pushOption(activeProvider, activeModel);
  return options;
}

function readPinnedSessions(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SESSION_PIN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readSessionDrafts(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SESSION_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function Pill({ variant, children }: { variant: PillVariant; children: React.ReactNode }) {
  return <span className={`pill ${variant}`}>{children}</span>;
}

function IconBtn({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return <button className="icon-btn" type="button" aria-label={label} onClick={onClick}>{children}</button>;
}

function ToolBtn({ primary, children, onClick }: { primary?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return <button className={`tool-btn${primary ? " primary" : ""}`} type="button" onClick={onClick}>{children}</button>;
}

function GlobalBanner({ variant, title, detail }: { variant: BannerVariant; title: string; detail?: string }) {
  return (
    <div className={`global-banner ${variant}`}>
      <strong>{title}</strong>
      {detail ? <p className="muted">{detail}</p> : null}
    </div>
  );
}

function signalToneForRunStatus(status: DesktopRun["status"] | null): SignalTone {
  if (status === "running") return "success";
  if (status === "needs_approval" || status === "pending" || status === "paused") return "warn";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "completed") return "accent";
  return "neutral";
}

function SignalPill({ tone, children }: { tone: SignalTone; children: React.ReactNode }) {
  return <span className={`signal-pill ${tone}`}>{children}</span>;
}

function StatusCard({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone?: SignalTone;
  detail?: string;
}) {
  return (
    <div className="status-card">
      <div className="status-card-top">
        <span className="tiny">{label}</span>
        <SignalPill tone={tone ?? "neutral"}>{value}</SignalPill>
      </div>
      {detail ? <p className="muted">{detail}</p> : null}
    </div>
  );
}

function SurfaceNavButton({
  active,
  label,
  count,
  onClick,
}: {
  active?: boolean;
  label: string;
  count?: string;
  onClick?: () => void;
}) {
  return (
    <button className={`surface-nav-btn${active ? " active" : ""}`} type="button" onClick={onClick}>
      <span>{label}</span>
      {count ? <span className="surface-nav-count">{count}</span> : null}
    </button>
  );
}

function LaunchCard({
  title,
  detail,
  meta,
  onClick,
}: {
  title: string;
  detail: string;
  meta: string;
  onClick?: () => void;
}) {
  return (
    <button className="launch-card" type="button" onClick={onClick}>
      <div className="launch-card-top">
        <strong>{title}</strong>
        <span className="tiny">进入</span>
      </div>
      <p className="muted">{detail}</p>
      <span className="launch-card-meta">{meta}</span>
    </button>
  );
}

function NewSessionDialog({
  open,
  value,
  saving,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  value: string;
  saving: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h3>新建会话</h3>
            <p className="muted">按 Craft 的方式保留在画布里，不再弹原生 prompt。</p>
          </div>
          <IconBtn label="关闭" onClick={onClose}>×</IconBtn>
        </div>
        <div className="dialog-body">
          <label className="tiny">会话标题</label>
          <input
            autoFocus
            className="settings-input"
            value={value}
            maxLength={80}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder="例如：继续修桌面 runtime 和 UI"
          />
          <p className="muted">标题会直接进会话列表、首页入口和运行侧栏。</p>
          {error ? <GlobalBanner variant="danger" title="创建会话失败" detail={error} /> : null}
        </div>
        <div className="dialog-actions">
          <ToolBtn onClick={onClose}>取消</ToolBtn>
          <ToolBtn primary onClick={onSubmit}>{saving ? "创建中..." : "创建会话"}</ToolBtn>
        </div>
      </div>
    </div>
  );
}

function SessionLifecycleDialog({
  open,
  mode,
  session,
  value,
  saving,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "rename" | "archive" | "delete";
  session: DesktopSession | null;
  value: string;
  saving: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  if (!open || !session) return null;
  const isRename = mode === "rename";
  const isArchive = mode === "archive";
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <h3>{isRename ? "重命名会话" : isArchive ? (session.status === "archived" ? "恢复会话" : "归档会话") : "删除会话"}</h3>
            <p className="muted">{isRename ? "修改侧栏、首页和工作区里的会话标题。" : isArchive ? (session.status === "archived" ? "恢复到活跃区，重新进入工作流。" : "先从活跃流里收起来，但保留历史。") : "删除后会从桌面工作台中移除，正在运行的会话不能删除。"}</p>
          </div>
          <IconBtn label="关闭" onClick={onClose}>×</IconBtn>
        </div>
        <div className="dialog-body" style={{ display: "grid", gap: 12 }}>
          <div className="detail-row"><span className="detail-key">当前会话</span><span className="detail-value">{session.title}</span></div>
          {isRename ? (
            <>
              <label className="tiny">新标题</label>
              <input
                autoFocus
                className="settings-input"
                value={value}
                maxLength={80}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
                placeholder="例如：继续修桌面 runtime 和 UI"
              />
            </>
          ) : (
            <GlobalBanner
              variant={mode === "delete" ? "danger" : "warn"}
              title={mode === "delete" ? "确认永久移出当前桌面会话列表" : (session.status === "archived" ? "恢复后会重新进入活跃列表" : "归档后会话仍可在“全部 / 已归档”里查看")}
              detail={mode === "delete" ? "底层历史不会立刻物理清库，但该会话会从工作台入口消失。" : "这是整理工作台，不是销毁运行记录。"}
            />
          )}
          {error ? <GlobalBanner variant="danger" title="会话操作失败" detail={error} /> : null}
        </div>
        <div className="dialog-actions">
          <ToolBtn onClick={onClose}>取消</ToolBtn>
          <ToolBtn primary onClick={onSubmit}>{saving ? "处理中..." : isRename ? "保存标题" : isArchive ? (session.status === "archived" ? "恢复会话" : "归档会话") : "删除会话"}</ToolBtn>
        </div>
      </div>
    </div>
  );
}

function sessionPriority(session: DesktopSession, activeSessionId: string | null) {
  if (session.id === activeSessionId) return 1000;
  let score = 0;
  if (session.attention?.hasPendingApproval) score += 500 + (session.attention.pendingApprovalCount * 10);
  if (session.attention?.hasRunningRun) score += 300;
  if (session.attention?.hasFailedRun) score += 200;
  if (session.attention?.hasContextCompaction) score += 50;
  if (session.status === "active") score += 20;
  return score;
}

function formatEventKindLabel(kind: DesktopEvent["kind"]) {
  const labels: Record<DesktopEvent["kind"], string> = {
    thinking: "思考",
    message: "消息",
    tool_call: "工具调用",
    tool_result: "工具结果",
    tool_pipeline: "工具管线",
    error: "错误",
    system: "系统",
    approval_request: "请求审批",
    approval_granted: "审批通过",
    approval_denied: "审批拒绝",
    model_usage: "模型用量",
    context_compacted: "上下文压缩",
  };
  return labels[kind] ?? kind.replaceAll("_", " ");
}

function formatRunStatus(status: DesktopRun["status"] | null | undefined) {
  if (status === "running") return "运行中";
  if (status === "paused") return "待继续";
  if (status === "needs_approval") return "待审批";
  if (status === "pending") return "排队中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "空闲";
}

function formatSessionStatus(status: DesktopSession["status"]) {
  if (status === "active") return "进行中";
  if (status === "paused") return "已暂停";
  if (status === "archived") return "已归档";
  return status;
}

function formatStreamStateLabel(state: "idle" | "connecting" | "live" | "error") {
  if (state === "live") return "实时";
  if (state === "connecting") return "连接中";
  if (state === "error") return "异常";
  return "空闲";
}

function formatTimelineLaneLabel(lane: TimelineLane | "all") {
  const labels: Record<TimelineLane | "all", string> = {
    all: "全部",
    conversation: "对话",
    tools: "工具",
    approvals: "审批",
    errors: "错误",
    context: "上下文",
    system: "系统",
  };
  return labels[lane] ?? lane;
}

function isHttpArtifactUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function isProbablyLocalArtifactUri(uri: string): boolean {
  return uri.startsWith("file://") || uri.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(uri);
}

function compactArtifactUri(uri: string): string {
  if (uri.length <= 42) return uri;
  return `${uri.slice(0, 18)}…${uri.slice(-16)}`;
}

function formatAttachmentSize(size: number | null): string {
  if (!size || size <= 0) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileUriFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const withLeadingSlash = /^[a-zA-Z]:\//.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(withLeadingSlash)}`;
}

function desktopAttachmentFromFile(file: File): DesktopAttachment | null {
  const path = typeof (file as File & { path?: unknown }).path === "string"
    ? (file as File & { path: string }).path
    : "";
  if (!path) return null;
  return {
    name: file.name || path.split(/[\\/]/).pop() || path,
    path,
    uri: fileUriFromPath(path),
    size: Number.isFinite(file.size) ? file.size : null,
  };
}

const EMPTY_TOKEN_USAGE: DesktopTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
  latestTotalTokens: null,
};

function normalizeTokenUsage(usage: DesktopTokenUsage | null | undefined): DesktopTokenUsage {
  if (!usage) return EMPTY_TOKEN_USAGE;
  return {
    inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0,
    totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0,
    requests: Number.isFinite(usage.requests) ? usage.requests : 0,
    latestTotalTokens: typeof usage.latestTotalTokens === "number" && Number.isFinite(usage.latestTotalTokens)
      ? usage.latestTotalTokens
      : null,
  };
}

function subtractTokenUsage(left: DesktopTokenUsage, right: DesktopTokenUsage): DesktopTokenUsage {
  return {
    inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    totalTokens: Math.max(0, left.totalTokens - right.totalTokens),
    requests: Math.max(0, left.requests - right.requests),
    latestTotalTokens: left.latestTotalTokens,
  };
}

function addTokenUsage(left: DesktopTokenUsage, right: DesktopTokenUsage): DesktopTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    requests: left.requests + right.requests,
    latestTotalTokens: right.latestTotalTokens ?? left.latestTotalTokens,
  };
}

function summarizeModelUsage(events: DesktopEvent[]): DesktopTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let requests = 0;
  let latestTotalTokens: number | null = null;

  for (const event of events) {
    if (event.kind !== "model_usage") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const input = typeof payload?.inputTokens === "number" ? payload.inputTokens : 0;
    const output = typeof payload?.outputTokens === "number" ? payload.outputTokens : 0;
    const total = typeof payload?.totalTokens === "number"
      ? payload.totalTokens
      : typeof payload?.promptEstimateTokens === "number"
        ? payload.promptEstimateTokens
        : input + output;
    inputTokens += input;
    outputTokens += output;
    totalTokens += total;
    latestTotalTokens = typeof payload?.cumulativeTotalTokens === "number" ? payload.cumulativeTotalTokens : total;
    requests += 1;
  }

  return { inputTokens, outputTokens, totalTokens, requests, latestTotalTokens };
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

function eventTone(kind: DesktopEvent["kind"]): SignalTone {
  if (kind === "error") return "danger";
  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") return "warn";
  if (kind === "tool_result") return "success";
  if (kind === "tool_call" || kind === "tool_pipeline" || kind === "context_compacted" || kind === "model_usage") return "accent";
  return "neutral";
}

function eventLane(kind: DesktopEvent["kind"]): string {
  if (kind === "message") return "conversation";
  if (kind === "tool_call" || kind === "tool_result" || kind === "tool_pipeline") return "tools";
  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") return "approvals";
  if (kind === "error") return "errors";
  if (kind === "context_compacted" || kind === "model_usage") return "context";
  return "system";
}

type TimelineLane = ReturnType<typeof eventLane>;

function scrollTranscriptToLatest(node: HTMLDivElement | null): void {
  if (!node) return;
  const scrollHost = node.closest(".chat-surface") as HTMLElement | null;
  const target = scrollHost ?? node;
  target.scrollTo({ top: target.scrollHeight, behavior: "auto" });
  if (target !== node) {
    node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
  }
}

function SessionCard({ active, session, pinned, onClick, onTogglePin }: {
  active?: boolean;
  pinned?: boolean;
  session: DesktopSession;
  onClick?: () => void;
  onTogglePin?: () => void;
}) {
  const statusLabel = active
    ? "当前会话"
    : session.attention?.hasPendingApproval
      ? `待审批 ${session.attention.pendingApprovalCount}`
      : session.attention?.hasFailedRun
        ? "失败"
        : session.attention?.latestRunStatus === "paused"
          ? "待继续"
        : session.attention?.hasRunningRun
          ? "运行中"
          : formatSessionStatus(session.status);
  return (
    <article className={`session-card${active ? " active" : ""}${pinned ? " pinned" : ""}`} onClick={onClick} style={{ cursor: "pointer" }}>
      <div className="session-top" style={{ alignItems: "center", gap: 8 }}>
        <div className="session-name-row">
          <div className="session-name">{session.title}</div>
          {onTogglePin ? (
            <button
              className={`session-pin-btn${pinned ? " active" : ""}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin();
              }}
              aria-label={pinned ? "取消固定会话" : "固定会话"}
            >
              {pinned ? "★" : "☆"}
            </button>
          ) : null}
        </div>
        <span className="session-card-status">{statusLabel}</span>
      </div>
      <div className="session-card-meta">
        <span>{formatAgeFromTimestamp(session.updatedAt) ?? "刚刚更新"}</span>
        {pinned ? <span>已固定</span> : null}
      </div>
    </article>
  );
}

function Message({ role, from, time, children }: {
  role?: "user" | "system"; from: string; time: string; children: React.ReactNode;
}) {
  return (
    <article className={`timeline-node message${role ? " " + role : ""}`}>
      <div className="timeline-rail">
        <div className={`timeline-dot ${role === "user" ? "user" : role === "system" ? "system" : "assistant"}`} />
      </div>
      <div className="timeline-body">
        <div className="timeline-node-head">
          <SignalPill tone={role === "user" ? "accent" : "neutral"}>{role === "user" ? "输入" : role === "system" ? "系统" : "助手"}</SignalPill>
          <div className="message-meta"><span>{from}</span><span>{time}</span></div>
        </div>
        {children}
      </div>
    </article>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return <div className="message-markdown">{renderMarkdownBlocks(content)}</div>;
}

function renderMarkdownBlocks(content: string): React.ReactNode[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([\w.+-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <div className="markdown-codeblock" key={`code-${blockIndex++}`}>
          {language ? <span className="markdown-code-lang">{language}</span> : null}
          <pre><code>{codeLines.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const headingKey = `heading-${blockIndex++}`;
      const inline = renderMarkdownInline(text, headingKey);
      if (level === 1) blocks.push(<h1 key={headingKey}>{inline}</h1>);
      else if (level === 2) blocks.push(<h2 key={headingKey}>{inline}</h2>);
      else if (level === 3) blocks.push(<h3 key={headingKey}>{inline}</h3>);
      else blocks.push(<h4 key={headingKey}>{inline}</h4>);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test((lines[index] ?? "").trim())) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${blockIndex++}`}>
          {renderMarkdownInline(quoteLines.join("\n"), `quote-${blockIndex}`)}
        </blockquote>,
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = splitMarkdownTableRow(lines[index] ?? "");
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        rows.push(splitMarkdownTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${blockIndex++}`}>
          <table>
            <thead>
              <tr>{headers.map((cell, cellIndex) => <th key={`h-${cellIndex}`}>{renderMarkdownInline(cell, `th-${blockIndex}-${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`c-${rowIndex}-${cellIndex}`}>{renderMarkdownInline(row[cellIndex] ?? "", `td-${blockIndex}-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? "").trim();
        const match = orderedList ? current.match(/^\d+[.)]\s+(.+)$/) : current.match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]!.trim());
        index += 1;
      }
      const ListTag = orderedList ? "ol" : "ul";
      blocks.push(
        <ListTag key={`list-${blockIndex++}`}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderMarkdownInline(item, `li-${blockIndex}-${itemIndex}`)}</li>)}
        </ListTag>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isMarkdownBlockBoundary(lines, index)) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p key={`p-${blockIndex++}`}>
        {renderMarkdownInline(paragraphLines.join("\n").trim(), `p-${blockIndex}`)}
      </p>,
    );
  }

  return blocks;
}

function renderMarkdownInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let index = 0;
  let textBuffer = "";
  let nodeIndex = 0;

  const flushText = () => {
    if (!textBuffer) return;
    nodes.push(textBuffer);
    textBuffer = "";
  };

  while (index < text.length) {
    if (text.startsWith("`", index)) {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flushText();
        nodes.push(<code key={`${keyPrefix}-code-${nodeIndex++}`}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        flushText();
        nodes.push(<strong key={`${keyPrefix}-strong-${nodeIndex++}`}>{renderMarkdownInline(text.slice(index + 2, end), `${keyPrefix}-strong-${nodeIndex}`)}</strong>);
        index = end + 2;
        continue;
      }
    }

    if (text.startsWith("*", index) && !text.startsWith("**", index)) {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        flushText();
        nodes.push(<em key={`${keyPrefix}-em-${nodeIndex++}`}>{renderMarkdownInline(text.slice(index + 1, end), `${keyPrefix}-em-${nodeIndex}`)}</em>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("[", index)) {
      const close = text.indexOf("]", index + 1);
      const openParen = close >= 0 ? text.indexOf("(", close + 1) : -1;
      const closeParen = openParen >= 0 ? text.indexOf(")", openParen + 1) : -1;
      if (close > index + 1 && openParen === close + 1 && closeParen > openParen + 1) {
        const label = text.slice(index + 1, close);
        const href = safeMarkdownHref(text.slice(openParen + 1, closeParen));
        if (href) {
          flushText();
          nodes.push(
            <a key={`${keyPrefix}-link-${nodeIndex++}`} href={href} target="_blank" rel="noreferrer">
              {renderMarkdownInline(label, `${keyPrefix}-link-${nodeIndex}`)}
            </a>,
          );
          index = closeParen + 1;
          continue;
        }
      }
    }

    textBuffer += text[index];
    index += 1;
  }

  flushText();
  return nodes;
}

function isMarkdownBlockBoundary(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^(#{1,4})\s+/.test(trimmed)) return true;
  if (/^>\s?/.test(trimmed)) return true;
  if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) return true;
  if (isMarkdownTableStart(lines, index)) return true;
  return false;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return isMarkdownTableRow(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && splitMarkdownTableRow(line).length >= 2;
}

function splitMarkdownTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function safeMarkdownHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[#/][^\s]*$/.test(href)) return href;
  return null;
}

function LegacySimpleChatTranscript({ events }: { events: DesktopEvent[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  type ChatTranscriptItem = {
    id: string;
    role?: "user" | "system";
    from: string;
    time: string;
    content: string;
    duplicateCount?: number;
  };

  const rawItems: ChatTranscriptItem[] = events.flatMap((event): ChatTranscriptItem[] => {
    const payload = eventPayloadRecord(event);
    if (event.kind === "message") {
      const content = typeof payload.content === "string" ? payload.content.trim() : "";
      if (!content) return [];
      return [{
        id: event.id,
        role: payload.role === "user" ? "user" as const : undefined,
        from: payload.role === "user" ? "你" : "拾光 Agent",
        time: new Date(event.createdAt).toLocaleTimeString(),
        content,
      }];
    }

    if (event.kind === "error") {
      const content = typeof payload.message === "string" ? payload.message.trim() : formatPayload(payload).trim();
      if (!content) return [];
      return [{
        id: event.id,
        role: "system" as const,
        from: "系统",
        time: new Date(event.createdAt).toLocaleTimeString(),
        content,
      }];
    }

    if (event.kind === "system" || event.kind === "approval_granted" || event.kind === "approval_denied") {
      const title = event.kind === "approval_granted"
        ? "审批已通过"
        : event.kind === "approval_denied"
          ? "审批已拒绝"
          : "系统消息";
      const body = typeof payload.message === "string"
        ? payload.message.trim()
        : typeof payload.content === "string"
          ? payload.content.trim()
          : "";
      return [{
        id: event.id,
        role: "system" as const,
        from: "系统",
        time: new Date(event.createdAt).toLocaleTimeString(),
        content: body ? `${title}\n${body}` : title,
      }];
    }

    return [];
  });

  const items = rawItems.reduce<ChatTranscriptItem[]>((acc, item) => {
    const prev = acc[acc.length - 1];
    const canCollapse = prev
      && item.role !== "user"
      && prev.role === item.role
      && prev.from === item.from
      && prev.content === item.content;
    if (!canCollapse) {
      acc.push(item);
      return acc;
    }
    prev.time = item.time;
    prev.duplicateCount = (prev.duplicateCount ?? 1) + 1;
    return acc;
  }, []);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    requestAnimationFrame(() => {
      scrollTranscriptToLatest(host);
      requestAnimationFrame(() => scrollTranscriptToLatest(host));
    });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="chat-transcript empty">
        <p className="muted">还没有聊天内容，发一条消息就会开始。</p>
      </div>
    );
  }

  return (
    <div className="chat-transcript" ref={scrollRef}>
      {items.map((item) => (
        <Message
          key={item.id}
          role={item.role}
          from={item.from}
          time={item.duplicateCount && item.duplicateCount > 1 ? `${item.time} · x${item.duplicateCount}` : item.time}
        >
          <MarkdownMessage content={item.content} />
        </Message>
      ))}
    </div>
  );
}

function SimpleChatTranscript({
  entries,
  liveEvents,
  showLiveEvents,
  pendingApprovals,
  decisionState,
  onApprovalDecision,
}: {
  entries: DesktopConversationEntry[];
  liveEvents: DesktopEvent[];
  showLiveEvents: boolean;
  pendingApprovals: DesktopApproval[];
  decisionState: Record<string, "approving" | "approved" | "denied" | undefined>;
  onApprovalDecision: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const approvalViewStates = useMemo(
    () => buildApprovalViewStates(entries, liveEvents, pendingApprovals, decisionState),
    [entries, liveEvents, pendingApprovals, decisionState],
  );
  type ChatTranscriptItem = {
    id: string;
    source: "turn" | "event";
    kind?: DesktopConversationEntry["kind"] | DesktopEvent["kind"] | "tool_activity";
    role?: "user" | "system";
    from: string;
    time: string;
    createdAt?: string;
    content: string;
    payload?: unknown;
    runId?: string | null;
    activity?: RunActivityTranscript;
    duplicateCount?: number;
  };

  const historyItems: ChatTranscriptItem[] = entries.flatMap((entry): ChatTranscriptItem[] => {
    if (entry.kind === "approval_granted" || entry.kind === "approval_denied") return [];
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (!content) return [];
    const turn = { role: entry.role };
    return [{
      id: entry.id,
      source: entry.source,
      kind: entry.kind,
      role: entry.role === "user" ? "user" : entry.role === "system" ? "system" : undefined,
      from: turn.role === "user" ? "你" : turn.role === "system" ? "系统" : "拾光 Agent",
      ...(entry.from ? { from: entry.from } : {}),
      time: new Date(entry.createdAt).toLocaleTimeString(),
      createdAt: entry.createdAt,
      content,
      payload: entry.payload,
      runId: entry.runId,
    }];
  });

  const persistedEventIds = new Set(
    historyItems
      .filter((item) => item.source === "event")
      .map((item) => item.id),
  );

  const liveItems: ChatTranscriptItem[] = !showLiveEvents ? [] : liveEvents.flatMap((event): ChatTranscriptItem[] => {
    const payload = eventPayloadRecord(event);
    if (event.kind === "context_compacted" || event.kind === "model_usage") return [];
    if (event.kind === "message") {
      if (payload.role === "user") return [];
      const content = typeof payload.content === "string" ? payload.content.trim() : "";
      if (!content) return [];
      if (persistedEventIds.has(`event:${event.id}`)) return [];
      return [{
        id: `event:${event.id}`,
        source: "event",
        from: "拾光 Agent",
        time: new Date(event.createdAt).toLocaleTimeString(),
        createdAt: event.createdAt,
        content,
      }];
    }

    if (event.kind === "error") {
      if (persistedEventIds.has(`event:${event.id}`)) return [];
      const content = typeof payload.message === "string" ? payload.message.trim() : formatPayload(payload).trim();
      if (!content) return [];
      return [{
        id: `event:${event.id}`,
        source: "event",
        kind: event.kind,
        role: "system" as const,
        from: "系统",
        time: new Date(event.createdAt).toLocaleTimeString(),
        content,
        payload: event.payload,
        runId: event.runId,
      }];
    }

    if (event.kind === "approval_granted" || event.kind === "approval_denied") return [];

    if (event.kind === "system" || event.kind === "approval_request") {
      if (persistedEventIds.has(`event:${event.id}`)) return [];
      const title = event.kind === "approval_request" ? "请求审批" : "系统消息";
      const body = typeof payload.message === "string"
        ? payload.message.trim()
        : typeof payload.content === "string"
          ? payload.content.trim()
          : "";
      return [{
        id: `event:${event.id}`,
        source: "event",
        kind: event.kind,
        role: "system" as const,
        from: "系统",
        time: new Date(event.createdAt).toLocaleTimeString(),
        content: body ? `${title}\n${body}` : title,
        payload: event.payload,
        runId: event.runId,
      }];
    }

    return [];
  });

  const activityItems: ChatTranscriptItem[] = !showLiveEvents ? [] : buildRunActivityTranscript(liveEvents).map((activity) => ({
    id: `activity:${activity.id}`,
    source: "event" as const,
    kind: "tool_activity" as const,
    role: "system" as const,
    from: "运行",
    time: new Date(activity.createdAt).toLocaleTimeString(),
    createdAt: activity.createdAt,
    content: `${activity.title}\n${activity.detail}`,
    payload: activity,
    runId: activity.runId,
    activity,
  }));

  const orderedItems = [...historyItems, ...liveItems, ...activityItems].sort(compareChatTranscriptItems);

  const items = orderedItems.reduce<ChatTranscriptItem[]>((acc, item) => {
    const prev = acc[acc.length - 1];
    const canCollapse = prev
      && item.role !== "user"
      && item.kind !== "approval_request"
      && prev.kind !== "approval_request"
      && item.kind !== "tool_activity"
      && prev.kind !== "tool_activity"
      && prev.role === item.role
      && prev.from === item.from
      && prev.content === item.content
      && (prev.source === "event" || item.source === "event");
    if (!canCollapse) {
      acc.push(item);
      return acc;
    }
    prev.time = item.time;
    prev.duplicateCount = (prev.duplicateCount ?? 1) + 1;
    return acc;
  }, []);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    requestAnimationFrame(() => {
      scrollTranscriptToLatest(host);
      requestAnimationFrame(() => scrollTranscriptToLatest(host));
    });
  }, [items.length, entries.length, liveEvents.length]);

  if (items.length === 0) {
    return (
      <div className="chat-transcript empty">
        <p className="muted">还没有聊天内容，发一条消息就会开始。</p>
      </div>
    );
  }

  return (
    <div className="chat-transcript" ref={scrollRef}>
      {items.map((item) => {
        if (item.activity) {
          return (
            <RunActivityTranscriptNode
              key={item.id}
              activity={item.activity}
              time={item.duplicateCount && item.duplicateCount > 1 ? `${item.time} x${item.duplicateCount}` : item.time}
            />
          );
        }

        if (item.kind === "approval_request") {
          const payload = item.payload && typeof item.payload === "object" ? item.payload as { approvalId?: unknown } : {};
          const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
          const viewState = approvalId ? approvalViewStates.get(approvalId) : undefined;
          const approval = approvalId
            ? pendingApprovals.find((candidate) => candidate.id === approvalId) ?? approvalFromEventPayload(item.payload, item.runId, normalizeApprovalStatusForRecord(viewState?.status))
            : undefined;
          if (approval) {
            const displayApproval = viewState?.status && viewState.status !== "approving"
              ? { ...approval, status: viewState.status }
              : approval;
            return (
              <Message
                key={item.id}
                role="system"
                from="审批"
                time={item.duplicateCount && item.duplicateCount > 1 ? `${item.time} x${item.duplicateCount}` : item.time}
              >
                {viewState && viewState.status !== "pending" && viewState.status !== "approving" ? (
                  <ApprovalReceiptCard approval={displayApproval} viewState={viewState} />
                ) : (
                  <ApprovalReviewCard
                    approval={displayApproval}
                    decisionState={decisionState[approval.id]}
                    executionState={viewState}
                    onDecision={onApprovalDecision}
                  />
                )}
              </Message>
            );
          }
        }

        return (
          <Message
            key={item.id}
            role={item.role}
            from={item.from}
            time={item.duplicateCount && item.duplicateCount > 1 ? `${item.time} x${item.duplicateCount}` : item.time}
          >
            <MarkdownMessage content={item.content} />
          </Message>
        );
      })}
    </div>
  );
}

function compareChatTranscriptItems(a: { createdAt?: string; id: string }, b: { createdAt?: string; id: string }): number {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
  if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
  if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
  return a.id.localeCompare(b.id);
}

function buildRunActivityTranscript(events: DesktopEvent[]): RunActivityTranscript[] {
  const latestByCall = new Map<string, DesktopEvent>();

  for (const event of events) {
    if (event.kind !== "tool_pipeline") continue;
    const payload = eventPayloadRecord(event);
    const phase = typeof payload.phase === "string" ? payload.phase : null;
    if (!phase) continue;
    const toolName = toolEventName(event) ?? "tool";
    const callKey = typeof payload.toolCallId === "string"
      ? payload.toolCallId
      : typeof payload.approvalId === "string"
        ? payload.approvalId
        : event.id;
    const key = `${event.runId}:${toolName}:${callKey}`;
    const existing = latestByCall.get(key);
    if (!existing || Date.parse(event.createdAt) >= Date.parse(existing.createdAt)) {
      latestByCall.set(key, event);
    }
  }

  return Array.from(latestByCall.values())
    .map(activityFromToolPipelineEvent)
    .filter((activity): activity is RunActivityTranscript => Boolean(activity))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MAX_CHAT_ACTIVITY_ITEMS);
}

function activityFromToolPipelineEvent(event: DesktopEvent): RunActivityTranscript | null {
  const summary = summarizeToolPipelineEvent(event);
  if (!summary) return null;
  const payload = eventPayloadRecord(event);
  const phase = typeof payload.phase === "string" ? payload.phase : "unknown";
  const toolName = toolEventName(event);
  const toolLabel = formatToolActivityName(toolName);
  const title = formatToolActivityTranscriptTitle(toolName, phase, payload, summary.label);
  const detail = formatToolActivityTranscriptDetail(toolName, phase, payload, summary.detail);
  const meta = [
    activityScopeLabel(toolName, payload),
  ].filter((item): item is string => Boolean(item));
  const idPart = typeof payload.toolCallId === "string"
    ? payload.toolCallId
    : typeof payload.approvalId === "string"
      ? payload.approvalId
      : event.id;

  return {
    id: `${event.runId}:${toolName ?? "tool"}:${idPart}`,
    runId: event.runId,
    title,
    detail,
    tone: summary.tone,
    phase,
    phaseLabel: formatToolPhaseLabel(phase),
    toolName,
    toolLabel,
    createdAt: event.createdAt,
    meta,
    active: phase === "pre_execute" || phase === "executing" || phase === "approval_required" || phase === "approved",
  };
}

function RunActivityTranscriptNode({ activity, time }: { activity: RunActivityTranscript; time: string }) {
  const dotTone = activity.tone === "neutral" ? "accent" : activity.tone;
  return (
    <article className={`timeline-node run-activity-node ${activity.tone}${activity.active ? " active" : ""}`}>
      <div className="timeline-rail">
        <div className={`timeline-dot ${dotTone}${activity.active ? " pulse" : ""}`} />
      </div>
      <div className="timeline-body">
        <div className="run-activity-inline-head">
          <div className="run-activity-title">
            <span className="run-activity-icon" aria-hidden="true" />
            <strong>{activity.title}</strong>
          </div>
          <div className="message-meta"><span>{activity.phaseLabel}</span><span>{time}</span></div>
        </div>
        <p className="run-activity-text">{activity.detail}</p>
        {activity.meta.length > 0 ? (
          <div className="run-activity-meta">
            {activity.meta.map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
      </div>
    </article>
  );
}

type ApprovalViewStatus = DesktopApproval["status"] | "approving";
type ApprovalExecutionState = "waiting" | "approved" | "executing" | "executed" | "failed" | "denied" | "expired";

interface ApprovalViewState {
  status: ApprovalViewStatus;
  execution: ApprovalExecutionState;
  label: string;
  detail: string;
  updatedAt: string | null;
}

function normalizeApprovalStatusForRecord(status: ApprovalViewStatus | undefined): DesktopApproval["status"] {
  return status === "granted" || status === "denied" || status === "expired" ? status : "pending";
}

function buildApprovalViewStates(
  entries: DesktopConversationEntry[],
  liveEvents: DesktopEvent[],
  pendingApprovals: DesktopApproval[],
  decisionState: Record<string, "approving" | "approved" | "denied" | undefined>,
): Map<string, ApprovalViewState> {
  const states = new Map<string, ApprovalViewState>();
  const ensure = (approvalId: string): ApprovalViewState => {
    const existing = states.get(approvalId);
    if (existing) return existing;
    const next: ApprovalViewState = {
      status: "pending",
      execution: "waiting",
      label: "等待审批",
      detail: "高风险动作正在等待你确认。",
      updatedAt: null,
    };
    states.set(approvalId, next);
    return next;
  };
  const update = (approvalId: string, patch: Partial<ApprovalViewState>) => {
    states.set(approvalId, { ...ensure(approvalId), ...patch });
  };

  for (const approval of pendingApprovals) {
    const execution = approval.status === "pending"
      ? "waiting"
      : approval.status === "granted"
        ? "approved"
        : approval.status;
    update(approval.id, {
      status: approval.status,
      execution,
      label: approval.status === "pending" ? "等待审批" : formatApprovalStatusLabel(approval.status),
      detail: approval.status === "pending" ? "这条工具调用尚未执行，等待你通过或拒绝。" : formatApprovalResolvedDetail(approval.status),
      updatedAt: approval.decidedAt,
    });
  }

  const sources = [
    ...entries.map((entry) => ({ kind: entry.kind, payload: entry.payload, createdAt: entry.createdAt })),
    ...liveEvents.map((event) => ({ kind: event.kind, payload: event.payload, createdAt: event.createdAt })),
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const source of sources) {
    const payload = payloadRecord(source.payload);
    const approvalId = approvalIdFromPayload(payload);
    if (!approvalId) continue;
    const phase = typeof payload.phase === "string" ? payload.phase : null;
    const summary = typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : null;
    const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;

    if (source.kind === "approval_request" || phase === "approval_required") {
      update(approvalId, {
        status: "pending",
        execution: "waiting",
        label: "等待审批",
        detail: "这条工具调用尚未执行，等待你通过或拒绝。",
        updatedAt: source.createdAt,
      });
    } else if (source.kind === "approval_granted" || phase === "approved") {
      update(approvalId, {
        status: "granted",
        execution: "approved",
        label: "审批已通过",
        detail: "已授权，Agent 正在从这条工具调用继续。",
        updatedAt: source.createdAt,
      });
    } else if (source.kind === "approval_denied" || phase === "denied") {
      update(approvalId, {
        status: "denied",
        execution: "denied",
        label: "审批已拒绝",
        detail: "这条工具调用没有执行，当前运行停在审批处。",
        updatedAt: source.createdAt,
      });
    } else if (phase === "approval_executed") {
      update(approvalId, {
        status: "granted",
        execution: "executed",
        label: "已执行",
        detail: summary ? `工具已执行：${truncateInline(summary, 160)}` : "审批通过后的工具调用已经执行完成。",
        updatedAt: source.createdAt,
      });
    } else if (phase === "approval_failed") {
      update(approvalId, {
        status: "granted",
        execution: "failed",
        label: "执行失败",
        detail: error ? `审批通过后执行失败：${truncateInline(error, 160)}` : "审批已通过，但工具执行失败。",
        updatedAt: source.createdAt,
      });
    }
  }

  for (const [approvalId, state] of Object.entries(decisionState)) {
    if (state === "approving") {
      update(approvalId, {
        status: "approving",
        execution: "approved",
        label: "正在处理审批",
        detail: "正在提交你的审批决定，请稍等。",
      });
    } else if (state === "approved") {
      update(approvalId, {
        status: "granted",
        execution: "approved",
        label: "审批已通过",
        detail: "已通过，Agent 正在恢复运行。",
      });
    } else if (state === "denied") {
      update(approvalId, {
        status: "denied",
        execution: "denied",
        label: "审批已拒绝",
        detail: "已拒绝，当前运行会停在这里。",
      });
    }
  }

  return states;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function approvalIdFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.approvalId === "string") return payload.approvalId;
  const request = payload.request;
  if (request && typeof request === "object") {
    const nested = request as Record<string, unknown>;
    if (typeof nested.approvalId === "string") return nested.approvalId;
  }
  return null;
}

function formatApprovalStatusLabel(status: DesktopApproval["status"]): string {
  if (status === "granted") return "审批已通过";
  if (status === "denied") return "审批已拒绝";
  if (status === "expired") return "审批已过期";
  return "等待审批";
}

function formatApprovalResolvedDetail(status: DesktopApproval["status"]): string {
  if (status === "granted") return "审批已通过，运行已继续。";
  if (status === "denied") return "审批已拒绝，工具没有执行。";
  if (status === "expired") return "审批已过期，不再可处理。";
  return "这条工具调用尚未执行。";
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (payload === null || payload === undefined) return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function approvalFromEventPayload(
  payload: unknown,
  runId: string | null | undefined,
  status: DesktopApproval["status"] = "pending",
): DesktopApproval | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const id = typeof record.approvalId === "string" ? record.approvalId : undefined;
  if (!id || !runId) return undefined;

  return {
    id,
    runId,
    pluginId: typeof record.pluginId === "string" ? record.pluginId : "runtime",
    capability: typeof record.capability === "string" ? record.capability : "tool.approval",
    status,
    request: record.request,
    decidedAt: null,
  };
}

function eventPayloadRecord(event: DesktopEvent): Record<string, unknown> {
  return (typeof event.payload === "object" && event.payload !== null)
    ? event.payload as Record<string, unknown>
    : {};
}

function isAutoContinuationEvent(event: DesktopEvent): boolean {
  return event.kind === "system" && eventPayloadRecord(event).autoContinuation === true;
}

function isMeaningfulCompactionEvent(event: DesktopEvent): boolean {
  const payload = eventPayloadRecord(event);
  if (payload.compressionTriggered !== true) return false;
  const originalBudget = typeof payload.originalBudget === "number" ? payload.originalBudget : 0;
  const finalBudget = typeof payload.finalBudget === "number" ? payload.finalBudget : originalBudget;
  const savedBudget = originalBudget - finalBudget;
  const savedRatio = originalBudget > 0 ? savedBudget / originalBudget : 0;
  return payload.usedLlmCompactor === true || savedBudget >= 128 || savedRatio >= 0.1;
}

function toolEventName(event: DesktopEvent): string | null {
  const payload = eventPayloadRecord(event);
  const tool = payload.tool;
  return typeof tool === "string" ? tool : null;
}

function formatToolActivityName(toolName: string | null): string {
  if (!toolName) return "工具";
  const labels: Record<string, string> = {
    inspect_project: "检查项目结构",
    list_directory: "浏览目录",
    stat_path: "读取路径信息",
    search_workspace: "搜索工作区",
    read_text_file: "读取文件",
    write_text_file: "写入文件",
    patch_text_file: "修改文件",
    copy_path: "复制路径",
    move_path: "移动路径",
    delete_path: "删除路径",
    run_terminal_command: "运行终端命令",
    run_validation: "运行验证",
    collect_diagnostics: "收集诊断",
    code_map: "生成代码地图",
    symbol_search: "搜索符号",
    dependency_graph: "分析依赖",
    github_repo: "读取 GitHub 仓库",
    web_search: "搜索网页",
    web_fetch: "抓取网页",
    list_custom_extensions: "查看自定义扩展",
    create_custom_skill: "创建 Skill",
    create_custom_tool: "创建自定义工具",
    run_custom_tool: "运行自定义工具",
    search_memory: "搜索记忆",
    remember_fact: "写入记忆",
    forget_memory: "删除记忆",
    completion_check: "确认任务完成度",
  };
  return labels[toolName] ?? toolName.replace(/^mcp_/, "调用 MCP：").replace(/_/g, " ");
}

function formatToolActivityTranscriptTitle(
  toolName: string | null,
  phase: string,
  payload: Record<string, unknown>,
  fallback: string,
): string {
  const toolLabel = formatToolActivityName(toolName);
  if (phase === "approval_required") return `等待审批：${toolLabel}`;
  if (phase === "approved") return `审批通过：${toolLabel}`;
  if (phase === "denied") return `审批拒绝：${toolLabel}`;
  if (phase === "approval_executed") return formatToolPastTenseTitle(toolName, payload) || `已执行：${toolLabel}`;
  if (phase === "approval_failed") return `${toolLabel}执行失败`;
  if (phase === "failed") return `${toolLabel}失败`;
  if (phase === "completed") return formatToolPastTenseTitle(toolName, payload) || `${toolLabel}完成`;
  if (phase === "executing") return `正在${toolLabel}`;
  if (phase === "pre_execute") return `准备${toolLabel}`;
  return fallback;
}

function formatToolPastTenseTitle(toolName: string | null, payload: Record<string, unknown>): string | null {
  const output = payloadRecord(payload.output);
  const input = payloadRecord(payload.input);
  const command = typeof output.command === "string"
    ? output.command
    : typeof input.command === "string"
      ? input.command
      : "";
  const labels: Record<string, string> = {
    inspect_project: "检查了项目结构",
    list_directory: "浏览了目录",
    stat_path: "读取了路径信息",
    search_workspace: "搜索了工作区",
    read_text_file: "读取了文件",
    write_text_file: "写入了文件",
    patch_text_file: "修改了文件",
    copy_path: "复制了路径",
    move_path: "移动了路径",
    delete_path: "删除了路径",
    run_validation: "运行了验证",
    collect_diagnostics: "收集了诊断",
    code_map: "生成了代码地图",
    symbol_search: "搜索了符号",
    dependency_graph: "分析了依赖",
    github_repo: "读取了 GitHub 仓库",
    web_search: "搜索了网页",
    web_fetch: "抓取了网页",
    list_custom_extensions: "查看了自定义扩展",
    create_custom_skill: "创建了 Skill",
    create_custom_tool: "创建了自定义工具",
    run_custom_tool: "运行了自定义工具",
    search_memory: "搜索了记忆",
    remember_fact: "写入了记忆",
    forget_memory: "删除了记忆",
    completion_check: "确认了完成度",
  };
  if (toolName === "run_terminal_command") {
    return commandLooksComposite(command) ? "运行了多个命令" : "运行了命令";
  }
  return toolName ? labels[toolName] ?? null : null;
}

function formatToolActivityTranscriptDetail(
  toolName: string | null,
  phase: string,
  payload: Record<string, unknown>,
  fallback: string,
): string {
  if (phase === "completed" || phase === "approval_executed") {
    return summarizeToolOutputDetail(toolName, payload.output, fallback);
  }
  if (phase === "failed" || phase === "approval_failed") {
    const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : fallback;
    return truncateInline(error, 240);
  }
  if (phase === "approval_required") {
    const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : null;
    return reason ?? `需要你确认后才会执行：${summarizeToolActivityDetail(toolName, payload.input)}`;
  }
  if (phase === "approved") return "已收到你的审批，Agent 会从这个工具调用继续。";
  if (phase === "denied") return "你拒绝了这条工具调用，本轮不会执行它。";
  return summarizeToolActivityDetail(toolName, payload.input ?? payload.output) || fallback;
}

function formatToolPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    pre_execute: "准备",
    executing: "执行中",
    completed: "已完成",
    failed: "失败",
    approval_required: "待审批",
    approved: "已批准",
    denied: "已拒绝",
    approval_executed: "已执行",
    approval_failed: "执行失败",
  };
  return labels[phase] ?? phase;
}

function activityScopeLabel(toolName: string | null, payload: Record<string, unknown>): string | null {
  const input = payloadRecord(payload.input);
  const output = payloadRecord(payload.output);
  const path = stringFromRecord(output, "path") ?? stringFromRecord(input, "path") ?? stringFromRecord(input, "cwd");
  const query = stringFromRecord(output, "query") ?? stringFromRecord(input, "query");
  const mode = stringFromRecord(output, "mode") ?? stringFromRecord(input, "mode");
  const command = stringFromRecord(output, "command") ?? stringFromRecord(input, "command");
  if (toolName === "run_validation" && mode) return `模式 ${mode}`;
  if (toolName === "run_terminal_command" && command) return truncateInline(command, 80);
  if (query) return truncateInline(query, 80);
  if (path) return truncateInline(path, 80);
  return null;
}

function summarizeToolOutputDetail(toolName: string | null, output: unknown, fallback = "工具执行完成。"): string {
  const record = payloadRecord(output);
  if (!record || Object.keys(record).length === 0) return fallback;

  if (toolName === "list_directory") {
    const path = stringFromRecord(record, "path") ?? "目录";
    const entries = Array.isArray(record.entries) ? record.entries : [];
    const shown = entries
      .slice(0, 6)
      .map((entry) => payloadRecord(entry).name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    return `已查看 ${path}，看到 ${entries.length} 个条目${shown.length ? `：${shown.join("、")}${entries.length > shown.length ? "…" : ""}` : "。"} `;
  }

  if (toolName === "read_text_file") {
    const path = stringFromRecord(record, "path") ?? "文件";
    const bytes = numberFromRecord(record, "bytes");
    const truncated = record.truncated === true;
    return `已读取 ${path}${bytes !== null ? `，${formatCompactBytes(bytes)}` : ""}${truncated ? "，内容较长已截断显示" : ""}。`;
  }

  if (toolName === "search_workspace") {
    const query = stringFromRecord(record, "query") ?? "关键词";
    const results = Array.isArray(record.results) ? record.results : [];
    const filesScanned = numberFromRecord(record, "filesScanned");
    const first = results.length > 0 ? payloadRecord(results[0]).file : null;
    return `搜索 "${query}"，找到 ${results.length} 处结果${first ? `，首个在 ${first}` : ""}${filesScanned !== null ? `；扫描 ${filesScanned} 个文件` : ""}。`;
  }

  if (toolName === "write_text_file" || toolName === "patch_text_file") {
    const path = stringFromRecord(record, "path") ?? "目标文件";
    const bytes = numberFromRecord(record, "bytes");
    return `已更新 ${path}${bytes !== null ? `，写入 ${formatCompactBytes(bytes)}` : ""}。`;
  }

  if (toolName === "copy_path" || toolName === "move_path" || toolName === "delete_path" || toolName === "stat_path") {
    const path = stringFromRecord(record, "path") ?? stringFromRecord(record, "from") ?? stringFromRecord(record, "to") ?? "目标路径";
    return `${formatToolActivityName(toolName)}完成：${path}。`;
  }

  if (toolName === "run_validation") {
    const ok = record.ok === true;
    const mode = stringFromRecord(record, "mode") ?? "auto";
    const summary = stringFromRecord(record, "summary");
    const commands = Array.isArray(record.commands) ? record.commands : [];
    const failed = commands.find((command) => payloadRecord(command).ok === false);
    const failedName = failed ? stringFromRecord(payloadRecord(failed), "name") : null;
    if (summary) return `${ok ? "验证通过" : "验证失败"}（${mode}）：${summary}${failedName ? `；失败命令 ${failedName}` : ""}`;
    return `${ok ? "验证通过" : "验证失败"}，模式 ${mode}${failedName ? `；失败命令 ${failedName}` : ""}。`;
  }

  if (toolName === "run_terminal_command") {
    const ok = record.ok === true;
    const command = stringFromRecord(record, "command") ?? "命令";
    const exitCode = numberFromRecord(record, "exitCode");
    const stdout = stringFromRecord(record, "stdout");
    const stderr = stringFromRecord(record, "stderr");
    const signal = stderr || stdout;
    return `${ok ? "命令完成" : "命令失败"}：${truncateInline(command, 120)}${exitCode !== null ? `，退出码 ${exitCode}` : ""}${signal ? `。输出：${truncateInline(signal, 160)}` : "。"} `;
  }

  if (toolName === "inspect_project") {
    const pkg = payloadRecord(record.package);
    const detected = payloadRecord(record.detected);
    const name = stringFromRecord(pkg, "name");
    const kind = stringFromRecord(detected, "kind") ?? stringFromRecord(detected, "type");
    return `已检查项目结构${name ? `：${name}` : ""}${kind ? `，识别为 ${kind}` : ""}。`;
  }

  if (toolName === "code_map") {
    const files = Array.isArray(record.files) ? record.files.length : numberFromRecord(record, "files");
    const symbols = Array.isArray(record.symbols) ? record.symbols.length : numberFromRecord(record, "symbols");
    return `代码地图已生成${files !== null ? `，覆盖 ${files} 个文件` : ""}${symbols !== null ? `、${symbols} 个符号` : ""}。`;
  }

  if (toolName === "completion_check") {
    const status = stringFromRecord(record, "status") ?? stringFromRecord(record, "result");
    const summary = stringFromRecord(record, "summary");
    return summary ? `完成度检查：${summary}` : `完成度检查${status ? `：${status}` : "已完成"}。`;
  }

  return truncateInline(fallback && fallback !== "工具执行完成。" ? fallback : summarizeToolBlockValue(output), 220);
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatCompactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function commandLooksComposite(command: string): boolean {
  return /&&|\|\||;|\r?\n|\|\s*\w/.test(command);
}

function summarizeToolActivityDetail(toolName: string | null, input: unknown): string {
  if (!input || typeof input !== "object") return input === undefined ? "等待工具返回结果。" : summarizeToolBlockValue(input);
  const record = input as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const query = typeof record.query === "string" ? record.query : undefined;
  const mode = typeof record.mode === "string" ? record.mode : undefined;
  const command = typeof record.command === "string" ? record.command : undefined;

  if (toolName === "read_text_file" && path) return `正在打开 ${path}`;
  if ((toolName === "write_text_file" || toolName === "patch_text_file") && path) return `准备更新 ${path}`;
  if (toolName === "run_validation") return `验证模式：${mode ?? "auto"}`;
  if (toolName === "search_workspace" && query) return `搜索：${query}`;
  if (toolName === "list_directory") return `目录：${path ?? "."}`;
  if (toolName === "run_terminal_command" && command) return truncateInline(command, 180);
  if (query) return `查询：${query}`;
  if (path) return `目标：${path}`;
  return summarizeToolBlockValue(input);
}

function toolPipelinePhase(event: DesktopEvent | null): string | null {
  if (!event || event.kind !== "tool_pipeline") return null;
  const phase = eventPayloadRecord(event).phase;
  return typeof phase === "string" ? phase : null;
}

function latestToolPipelineEvent(events: DesktopEvent[]): DesktopEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "tool_pipeline") return event;
  }
  return null;
}

function summarizeToolPipelineEvent(event: DesktopEvent | null): {
  label: string;
  detail: string;
  tone: SignalTone;
} | null {
  if (!event || event.kind !== "tool_pipeline") return null;
  const payload = eventPayloadRecord(event);
  const phase = toolPipelinePhase(event);
  const toolName = toolEventName(event);
  const toolLabel = formatToolActivityName(toolName);
  const inputDetail = payload.input !== undefined
    ? summarizeToolActivityDetail(toolName, payload.input)
    : "等待工具输入。";
  const outputDetail = payload.output !== undefined
    ? summarizeToolOutputDetail(toolName, payload.output)
    : "工具执行完成。";
  const errorDetail = typeof payload.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : "工具执行失败。";

  if (phase === "approval_required") {
    return {
      label: `等待审批：${toolLabel}`,
      detail: typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : inputDetail,
      tone: "warn",
    };
  }
  if (phase === "approved") {
    return { label: `已批准：${toolLabel}`, detail: "审批通过，准备恢复这条工具调用。", tone: "success" };
  }
  if (phase === "approval_executed") {
    const summary = typeof payload.summary === "string" && payload.summary.trim()
      ? payload.summary.trim()
      : "审批通过后的工具调用已执行完成。";
    return { label: `已执行：${toolLabel}`, detail: summary, tone: "success" };
  }
  if (phase === "approval_failed") {
    const error = typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : "审批通过后的工具调用执行失败。";
    return { label: `执行失败：${toolLabel}`, detail: error, tone: "danger" };
  }
  if (phase === "denied") {
    return { label: `已拒绝：${toolLabel}`, detail: "审批被拒绝，本轮不会执行这条工具调用。", tone: "danger" };
  }
  if (phase === "executing") {
    return { label: `正在${toolLabel}`, detail: inputDetail, tone: "accent" };
  }
  if (phase === "completed") {
    return { label: `${toolLabel}完成`, detail: outputDetail, tone: "success" };
  }
  if (phase === "failed") {
    return { label: `${toolLabel}失败`, detail: errorDetail, tone: "danger" };
  }
  if (phase === "pre_execute") {
    return { label: `准备${toolLabel}`, detail: inputDetail, tone: "accent" };
  }
  return null;
}

function toolEventCallId(event: DesktopEvent): string | null {
  const payload = eventPayloadRecord(event);
  const toolCallId = payload.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : null;
}

function summarizeToolBlockValue(value: unknown): string {
  const text = formatPayload(value).trim();
  return text ? text.slice(0, 96) : "空";
}

type ApprovalRequestPreview = {
  kind: string;
  title: string;
  path: string | null;
  operation: string | null;
  diff: string | null;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
  warnings: string[];
};

function parseApprovalPreview(value: unknown): ApprovalRequestPreview | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  return {
    kind: typeof payload.kind === "string" ? payload.kind : "summary",
    title: typeof payload.title === "string" ? payload.title : "Approval preview",
    path: typeof payload.path === "string" ? payload.path : null,
    operation: typeof payload.operation === "string" ? payload.operation : null,
    diff: typeof payload.diff === "string" ? payload.diff : null,
    additions: typeof payload.additions === "number" ? payload.additions : null,
    deletions: typeof payload.deletions === "number" ? payload.deletions : null,
    truncated: payload.truncated === true,
    warnings,
  };
}

function summarizeApprovalRequest(request: unknown): {
  toolName: string | null;
  reason: string | null;
  toolInput: string;
  preview: ApprovalRequestPreview | null;
} {
  if (!request || typeof request !== "object") {
    return {
      toolName: null,
      reason: null,
      toolInput: formatPayload(request),
      preview: null,
    };
  }

  const payload = request as { toolName?: unknown; toolInput?: unknown; reason?: unknown; preview?: unknown };
  return {
    toolName: typeof payload.toolName === "string" ? payload.toolName : null,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    toolInput: formatPayload(payload.toolInput),
    preview: parseApprovalPreview(payload.preview),
  };
}

type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

type ApprovalRiskInfo = {
  level: ApprovalRiskLevel;
  label: string;
  detail: string;
  tone: SignalTone;
};

function approvalRiskInfo(approval: DesktopApproval, summary: ReturnType<typeof summarizeApprovalRequest>): ApprovalRiskInfo {
  const text = [
    approval.capability,
    summary.toolName,
    summary.preview?.operation,
    summary.preview?.path,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/delete|remove|unlink|rmdir|rm\b|fs\.delete/.test(text)) {
    return {
      level: "critical",
      label: "高危变更",
      detail: "可能删除文件或破坏现有工作区内容，通过前请重点检查路径和 diff。",
      tone: "danger",
    };
  }
  if (/execute|process|terminal|command|shell|start_background|stop_background/.test(text)) {
    return {
      level: "high",
      label: "命令执行",
      detail: "会在本机工作区运行命令或进程，建议确认命令、cwd 和参数没有越界。",
      tone: "warn",
    };
  }
  if (/write|patch|move|copy|fs\.write|fs\.move/.test(text) || summary.preview?.diff) {
    return {
      level: "high",
      label: "文件写入",
      detail: "会修改工作区文件，重点查看目标路径、增删行和预览差异。",
      tone: "warn",
    };
  }
  if (/network|web|http|github|mcp/.test(text)) {
    return {
      level: "medium",
      label: "外部访问",
      detail: "会访问外部服务或扩展工具，确认请求范围符合当前任务。",
      tone: "accent",
    };
  }
  return {
    level: "medium",
    label: "需要确认",
    detail: "这是受保护动作，本次通过只会恢复当前这一条工具调用。",
    tone: "warn",
  };
}

function approvalRequestRecord(request: unknown): Record<string, unknown> {
  return request && typeof request === "object" ? request as Record<string, unknown> : {};
}

function approvalToolInputRecord(request: unknown): Record<string, unknown> | null {
  const payload = approvalRequestRecord(request);
  const input = payload.toolInput;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

function approvalInputText(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function approvalTargetLabel(approval: DesktopApproval, summary: ReturnType<typeof summarizeApprovalRequest>): string {
  const input = approvalToolInputRecord(approval.request);
  return summary.preview?.path
    ?? approvalInputText(input, ["path", "targetPath", "destination", "dest", "to", "cwd", "url", "command", "query"])
    ?? "当前工作区";
}

function approvalActionLabel(approval: DesktopApproval, summary: ReturnType<typeof summarizeApprovalRequest>): string {
  const tool = summary.toolName ?? approval.capability;
  const op = summary.preview?.operation;
  return op ? `${op}: ${tool}` : `审阅 ${tool}`;
}

function approvalScopeRows(approval: DesktopApproval, summary: ReturnType<typeof summarizeApprovalRequest>): Array<{ label: string; value: string }> {
  const input = approvalToolInputRecord(approval.request);
  const rows = [
    { label: "工具", value: summary.toolName ?? approval.capability },
    { label: "能力", value: approval.capability },
    { label: "目标", value: approvalTargetLabel(approval, summary) },
    { label: "授权范围", value: "仅当前这一次调用" },
  ];
  const cwd = approvalInputText(input, ["cwd"]);
  const command = approvalInputText(input, ["command"]);
  if (cwd && cwd !== rows[2]?.value) rows.push({ label: "工具 cwd", value: cwd });
  if (command && command !== rows[2]?.value) rows.push({ label: "命令", value: command });
  return rows;
}

function approvalSafetyChecks(risk: ApprovalRiskInfo, summary: ReturnType<typeof summarizeApprovalRequest>): string[] {
  const checks = [
    risk.level === "critical" ? "确认目标路径不是项目根目录、系统目录或无关文件。" : null,
    risk.level === "high" ? "确认这一步确实是完成当前任务所必需的最小动作。" : null,
    summary.preview?.diff ? "已生成 diff 预览，优先检查新增/删除内容是否符合预期。" : null,
    summary.preview?.truncated ? "diff 已截断，建议谨慎通过或先让 Agent 缩小改动范围。" : null,
    "通过后 Agent 会自动继续运行；拒绝会让当前 run 停止并记录原因。",
  ].filter((item): item is string => Boolean(item));
  return checks;
}

function compactApprovalInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "undefined") return "";
  return trimmed.length > 640 ? `${trimmed.slice(0, 640)}...` : trimmed;
}

function formatAgeFromTimestamp(timestamp: string | null | undefined, now = Date.now()): string | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  const diffMs = Math.max(0, now - parsed);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(days / 365);
  return `${years} 年前`;
}

function formatDurationFromMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function findLatestToolCallWithoutResult(events: DesktopEvent[]): DesktopEvent | null {
  const matchedCallIds = new Set<string>();
  const matchedToolNames = new Set<string>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "tool_result") {
      const callId = toolEventCallId(event);
      if (callId) {
        matchedCallIds.add(callId);
      } else {
        const toolName = toolEventName(event);
        if (toolName) matchedToolNames.add(toolName);
      }
      continue;
    }
    if (event.kind !== "tool_call") continue;

    const callId = toolEventCallId(event);
    if (callId) {
      if (matchedCallIds.has(callId)) continue;
      return event;
    }

    const toolName = toolEventName(event);
    if (toolName && matchedToolNames.has(toolName)) continue;
    return event;
  }

  return null;
}

function findLatestToolResult(events: DesktopEvent[], toolName?: string): DesktopEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== "tool_result") continue;
    if (!toolName || toolEventName(event) === toolName) return event;
  }
  return null;
}

function truncateInline(text: string | null | undefined, maxLength = 180): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function truncateBlock(text: string | null | undefined, maxLength = 4000): string {
  if (!text) return "";
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}\n…` : normalized;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("当前环境不支持剪贴板写入。");
  }
  await navigator.clipboard.writeText(text);
}

function extractCommandFailureSnippet(command: Record<string, unknown> | undefined): string | null {
  if (!command) return null;
  const stderr = typeof command.stderr === "string" ? truncateInline(command.stderr, 220) : "";
  const stdout = typeof command.stdout === "string" ? truncateInline(command.stdout, 220) : "";
  return stderr || stdout || null;
}

function inferSuspectLocationFromValidation(command: Record<string, unknown> | undefined): {
  file?: string;
  line?: number;
  errorCode?: string;
} {
  const text = `${typeof command?.stderr === "string" ? command.stderr : ""}\n${typeof command?.stdout === "string" ? command.stdout : ""}`;
  if (!text.trim()) return {};

  const fileLineMatch = text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/) 
    ?? text.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\)/);
  const errorCodeMatch = text.match(/\b([A-Z]{2,}\d{3,})\b/);

  return {
    ...(fileLineMatch?.[1] ? { file: fileLineMatch[1] } : {}),
    ...(fileLineMatch?.[2] ? { line: Number(fileLineMatch[2]) } : {}),
    ...(errorCodeMatch?.[1] ? { errorCode: errorCodeMatch[1] } : {}),
  };
}

function summarizeAttemptEvent(event: DesktopEvent | null): string | undefined {
  if (!event) return undefined;
  const toolName = toolEventName(event) ?? event.kind;
  const payload = eventPayloadRecord(event);
  if (event.kind === "tool_call") {
    const inputSummary = payload.input !== undefined ? summarizeToolBlockValue(payload.input) : "无输入";
    return `${toolName} · ${inputSummary}`;
  }
  if (event.kind === "tool_result") {
    const outputSummary = payload.output !== undefined ? summarizeToolBlockValue(payload.output) : "已返回结果";
    return `${toolName} · ${outputSummary}`;
  }
  return undefined;
}

function findLatestRepairAttempt(events: DesktopEvent[], beforeSeq: number | null): DesktopEvent | null {
  const candidateTools = new Set(["patch_text_file", "write_text_file", "search_workspace", "read_text_file", "run_terminal_command", "run_validation"]);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (beforeSeq !== null && event.seq >= beforeSeq) continue;
    if (event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    const toolName = toolEventName(event);
    if (!toolName || !candidateTools.has(toolName)) continue;
    return event;
  }
  return null;
}

function describeFailureInsight(run: DesktopRun | null, events: DesktopEvent[]): RunFailureInsight | null {
  if (!run) return null;

  const latestValidationResult = findLatestToolResult(events, "run_validation");
  const validationPayload = latestValidationResult ? eventPayloadRecord(latestValidationResult) : null;
  const validationOutput = validationPayload?.output && typeof validationPayload.output === "object"
    ? validationPayload.output as Record<string, unknown>
    : null;

  if (validationOutput?.ok === false) {
    const commands = Array.isArray(validationOutput.commands)
      ? validationOutput.commands.filter((command) => command && typeof command === "object") as Record<string, unknown>[]
      : [];
    const failedCommand = commands.find((command) => command.ok === false) ?? null;
    const suspect = inferSuspectLocationFromValidation(failedCommand ?? undefined);
    const failingCommandName = typeof failedCommand?.name === "string" ? failedCommand.name : undefined;
    const summary = typeof validationOutput.summary === "string" ? validationOutput.summary : (run.reason ?? "验证失败。正在等待下一次修复。");
    const cause = extractCommandFailureSnippet(failedCommand ?? undefined) ?? run.reason ?? "验证命令失败，但还没有抓到明确错误片段。";
    const stderrText = typeof failedCommand?.stderr === "string" ? truncateBlock(failedCommand.stderr, 3200) : "";
    const stdoutText = typeof failedCommand?.stdout === "string" ? truncateBlock(failedCommand.stdout, 3200) : "";
    const evidenceBlockContent = [
      stderrText ? `stderr\n${stderrText}` : null,
      stdoutText ? `stdout\n${stdoutText}` : null,
    ].filter((item): item is string => Boolean(item)).join("\n\n");
    const errorCode = suspect.errorCode;
    const suspectLabel = suspect.file ? `${suspect.file}${typeof suspect.line === "number" ? `:${suspect.line}` : ""}` : null;
    const nextStep = suspect.file
      ? `先回到 ${suspectLabel}${errorCode ? `，按 ${errorCode} 对应位置继续修` : "，直接读上下文并继续修"}。`
      : failingCommandName
        ? `先重看 ${failingCommandName} 的失败输出，再定位首个报错文件。`
        : "先展开最近一次 validation 输出，定位首个失败命令和报错文件。";
    const lastAttempt = summarizeAttemptEvent(findLatestRepairAttempt(events, latestValidationResult?.seq ?? null));
    const evidence = [
      failingCommandName ? `失败命令：${failingCommandName}` : null,
      suspectLabel ? `怀疑文件：${suspectLabel}` : null,
      errorCode ? `错误码：${errorCode}` : null,
    ].filter((item): item is string => Boolean(item));

    return {
      title: "失败原因",
      summary,
      cause,
      nextStep,
      tone: "danger",
      ...(suspect.file ? { suspectFile: suspect.file } : {}),
      ...(failingCommandName ? { failingCommand: failingCommandName } : {}),
      ...(lastAttempt ? { lastAttempt } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(evidenceBlockContent ? { evidenceBlockTitle: `${failingCommandName ?? "validation"} 原始输出`, evidenceBlockContent } : {}),
    };
  }

  const latestErrorEvent = [...events].reverse().find((event) => event.kind === "error") ?? null;
  if (run.status === "failed" || latestErrorEvent) {
    const errorPayload = latestErrorEvent ? eventPayloadRecord(latestErrorEvent) : null;
    const cause = typeof errorPayload?.message === "string"
      ? truncateInline(errorPayload.message, 220)
      : (run.reason ?? "运行结束在失败状态，但还没有结构化错误摘要。");
    const approvalDenied = [...events].reverse().find((event) => event.kind === "approval_denied") ?? null;
    const nextStep = approvalDenied
      ? "这次是审批拒绝导致中断；调整动作范围或确认能力后再重试。"
      : runActivityFallbackNextStep(run.reason);
    const rawErrorText = typeof errorPayload?.message === "string" ? truncateBlock(errorPayload.message, 3200) : "";
    const lastAttempt = summarizeAttemptEvent(findLatestRepairAttempt(events, null));
    const evidence = [approvalDenied ? "触发了 approval_denied" : null].filter((item): item is string => Boolean(item));
    return {
      title: "失败原因",
      summary: run.reason ?? "运行失败",
      cause,
      nextStep,
      tone: "danger",
      ...(lastAttempt ? { lastAttempt } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(rawErrorText ? { evidenceBlockTitle: "最近错误事件", evidenceBlockContent: rawErrorText } : {}),
    };
  }

  return null;
}

function runActivityFallbackNextStep(reason: string | null | undefined): string {
  const text = (reason ?? "").toLowerCase();
  if (/approval denied|permission|forbidden/.test(text)) {
    return "先确认权限/审批，再从同一会话继续恢复。";
  }
  if (/timeout|timed out|network|unavailable/.test(text)) {
    return "优先重试最近一步；如果继续超时，再换更小的命令或更短的上下文。";
  }
  if (/validation|test|typecheck|build|ts\d+/.test(text)) {
    return "先打开最近一次 validation 失败输出，锁定首个报错文件再继续修。";
  }
  return "先检查最近一条错误事件和上一条工具调用，再决定是重试还是换修复路径。";
}

function buildFailureRepairPrompt(failureInsight: NonNullable<ReturnType<typeof describeFailureInsight>>): string {
  const lines = [
    "继续修这个失败，不要重做无关部分。",
    `目标：${failureInsight.summary}`,
    `失败原因：${failureInsight.cause}`,
    `建议下一步：${failureInsight.nextStep}`,
  ];
  if (failureInsight.failingCommand) {
    lines.push(`失败命令：${failureInsight.failingCommand}`);
  }
  if (failureInsight.suspectFile) {
    lines.push(`优先检查文件：${failureInsight.suspectFile}`);
  }
  if (failureInsight.evidence && failureInsight.evidence.length > 0) {
    lines.push(`关键线索：${failureInsight.evidence.join("；")}`);
  }
  if (failureInsight.lastAttempt) {
    lines.push(`上次尝试：${failureInsight.lastAttempt}`);
  }
  lines.push("先读取相关文件/错误输出，定位首个可修复点，做最小修改后重新验证。");
  return lines.join("\n");
}

function buildRunQuickRepairPrompt(run: DesktopRun, artifactCount = 0): string {
  const lines = [
    "继续这个运行的后续工作，不要从零开始。",
    `运行：${run.id}`,
    `状态：${formatRunStatus(run.status)}`,
  ];
  if (run.summary) {
    lines.push(`摘要：${truncateInline(run.summary, 240)}`);
  }
  const displayReason = formatRunReasonForDisplay(run.reason);
  if (displayReason) {
    lines.push(`原因：${truncateInline(displayReason, 240)}`);
  }
  if (artifactCount > 0) {
    lines.push(`这个运行已有 ${artifactCount} 个产物，先看产物再继续。`);
  }
  lines.push("先检查这次运行的结果、报错和产物，再决定下一步；如果需要修复，做最小改动并重新验证。");
  return lines.join("\n");
}

function formatRunReasonForDisplay(reason: string | null | undefined): string | null {
  const value = reason?.trim();
  if (!value) return null;

  const stepLimitMatch = value.match(/Reached the\s+(\d+)-step budget before producing a final answer/i);
  if (stepLimitMatch) {
    return `本轮达到 ${stepLimitMatch[1]} 步安全预算，还没有形成最终反馈。运行已暂停以避免工具循环；继续工作会结合最近运行摘要、工具结果和工作区现状往下推进。`;
  }

  if (/Paused by user/i.test(value)) {
    return "已手动暂停。可以补充一句新要求，或直接点继续工作沿当前上下文推进。";
  }

  return value;
}

function describeRunActivity(
  run: DesktopRun | null,
  events: DesktopEvent[],
  pendingApprovals: DesktopApproval[],
): RunActivitySummary {
  if (!run) {
    return {
      label: "等待启动",
      detail: "还没有活跃运行。发送一条消息后，拾光会开始规划、调工具并产出时间线。",
      tone: "neutral",
      ageLabel: null,
      stalled: false,
      stalledDetail: null,
    };
  }

  const latestEvent = events[events.length - 1] ?? null;
  const lastEventAgeLabel = formatAgeFromTimestamp(latestEvent?.createdAt ?? run.startedAt ?? null);
  const latestThinkingEvent = [...events].reverse().find((event) => event.kind === "thinking") ?? null;
  const latestAssistantMessage = [...events].reverse().find((event) => event.kind === "message" && eventPayloadRecord(event).role !== "user") ?? null;
  const latestErrorEvent = [...events].reverse().find((event) => event.kind === "error") ?? null;
  const pendingApproval = pendingApprovals.find((approval) => approval.runId === run.id) ?? null;
  const latestPipelineSummary = summarizeToolPipelineEvent(latestToolPipelineEvent(events));
  const latestPendingToolCall = findLatestToolCallWithoutResult(events);
  const latestToolResult = [...events].reverse().find((event) => event.kind === "tool_result") ?? null;
  const latestToolResultPayload = latestToolResult ? eventPayloadRecord(latestToolResult) : null;
  const displayReason = formatRunReasonForDisplay(run.reason);

  let label = formatRunStatus(run.status);
  let detail = displayReason ?? "等待新的运行事件。";
  let tone = signalToneForRunStatus(run.status);

  if (run.status === "needs_approval") {
    const approvalSummary = summarizeApprovalRequest(pendingApproval?.request);
    label = approvalSummary.toolName ?? pendingApproval?.capability ?? "等待审批";
    detail = approvalSummary.reason
      ?? (approvalSummary.toolInput.trim()
        ? `待确认输入：${summarizeToolBlockValue(approvalSummary.toolInput)}`
        : "高风险动作已暂停，等你确认后继续。");
    tone = "warn";
  } else if (run.status === "paused") {
    label = "等待继续";
    detail = displayReason ?? "本轮到达步骤预算，已保留现场。点击继续工作后会结合最近运行摘要和工具结果继续推进。";
    tone = "warn";
  } else if (latestErrorEvent) {
    const payload = eventPayloadRecord(latestErrorEvent);
    label = run.status === "failed" ? "运行失败" : "最新错误";
    detail = typeof payload.message === "string"
      ? payload.message
      : (run.reason ?? "时间线记录了一次错误事件。") ;
    tone = "danger";
  } else if (latestPipelineSummary && (run.status === "running" || run.status === "pending")) {
    label = latestPipelineSummary.label;
    detail = latestPipelineSummary.detail;
    tone = latestPipelineSummary.tone;
  } else if (latestPendingToolCall) {
    const payload = eventPayloadRecord(latestPendingToolCall);
    const toolName = toolEventName(latestPendingToolCall) ?? "工具";
    label = formatToolActivityName(toolName);
    detail = payload.input !== undefined
      ? summarizeToolActivityDetail(toolName, payload.input)
      : "工具已发出，正在等待结果。";
    tone = "accent";
  } else if (latestToolResult) {
    const toolName = toolEventName(latestToolResult) ?? "工具";
    label = `${formatToolActivityName(toolName)}完成`;
    detail = latestToolResultPayload?.output !== undefined
      ? summarizeToolBlockValue(latestToolResultPayload.output)
      : "工具结果已返回。";
    tone = "success";
  } else if ((run.status === "running" || run.status === "pending") && latestThinkingEvent) {
    const payload = eventPayloadRecord(latestThinkingEvent);
    label = "规划下一步";
    detail = typeof payload.reasoning === "string" && payload.reasoning.trim()
      ? truncateInline(payload.reasoning, 180)
      : "正在理解上下文并决定下一步动作。";
    tone = "accent";
  } else if (latestAssistantMessage) {
    const payload = eventPayloadRecord(latestAssistantMessage);
    label = run.status === "completed" ? "已生成回复" : "整理回复";
    detail = typeof payload.content === "string"
      ? payload.content.slice(0, 180) || "助手消息已更新。"
      : "助手消息已更新。";
    tone = run.status === "completed" ? "success" : "accent";
  }

  const latestTimestamp = latestEvent?.createdAt ?? run.startedAt ?? null;
  const latestMs = latestTimestamp ? Date.parse(latestTimestamp) : Number.NaN;
  const isPendingLike = run.status === "running" || run.status === "pending";
  const stalled = isPendingLike && Number.isFinite(latestMs) ? Date.now() - latestMs > 45_000 : false;
  const stalledDetail = stalled
    ? `已经 ${formatAgeFromTimestamp(latestTimestamp) ?? "一段时间"} 没有新事件，可能正在等模型/命令返回。`
    : null;

  return {
    label,
    detail,
    tone,
    ageLabel: lastEventAgeLabel,
    stalled,
    stalledDetail,
  };
}

function describeRunPhase(
  run: DesktopRun | null,
  events: DesktopEvent[],
  pendingApprovals: DesktopApproval[],
): RunPhaseSummary {
  const baseSteps: RunPhaseStep[] = [
    { key: "boot", label: "启动", status: "idle" },
    { key: "plan", label: "规划", status: "idle" },
    { key: "tool", label: "执行", status: "idle" },
    { key: "reply", label: "回复", status: "idle" },
  ];
  if (!run) {
    return {
      label: "等待启动",
      detail: "先发一条消息，才会进入规划、调工具和生成回复。",
      tone: "neutral",
      steps: [{ ...baseSteps[0], status: "active" }, ...baseSteps.slice(1)],
      elapsedLabel: null,
      silenceLabel: null,
      latestEventLabel: null,
    };
  }

  const latestEvent = events[events.length - 1] ?? null;
  const latestThinkingEvent = [...events].reverse().find((event) => event.kind === "thinking") ?? null;
  const latestAssistantMessage = [...events].reverse().find((event) => event.kind === "message" && eventPayloadRecord(event).role !== "user") ?? null;
  const latestPipelineSummary = summarizeToolPipelineEvent(latestToolPipelineEvent(events));
  const latestPendingToolCall = findLatestToolCallWithoutResult(events);
  const latestToolResult = findLatestToolResult(events);
  const latestErrorEvent = [...events].reverse().find((event) => event.kind === "error") ?? null;
  const pendingApproval = pendingApprovals.find((approval) => approval.runId === run.id) ?? null;
  const displayReason = formatRunReasonForDisplay(run.reason);

  let currentStep: RunPhaseStep["key"] = run.status === "pending" ? "boot" : "plan";
  let label = "规划中";
  let detail = displayReason ?? "正在整理当前任务并决定下一步。";
  let tone: SignalTone = signalToneForRunStatus(run.status);

  if (run.status === "needs_approval") {
    const approvalSummary = summarizeApprovalRequest(pendingApproval?.request);
    currentStep = "tool";
    label = "等待审批";
    detail = approvalSummary.reason ?? "高风险动作已暂停，等你确认后继续。";
    tone = "warn";
  } else if (run.status === "paused") {
    currentStep = "reply";
    label = "等待继续";
    detail = displayReason ?? "本轮到达步骤预算，已保留现场。继续工作会沿最近运行摘要和工具结果往下推进。";
    tone = "warn";
  } else if (latestErrorEvent || run.status === "failed") {
    currentStep = latestPendingToolCall || latestToolResult ? "tool" : "reply";
    label = "运行受阻";
    detail = run.reason ?? "最近一次运行在处理中遇到错误。";
    tone = "danger";
  } else if (latestPipelineSummary && (run.status === "running" || run.status === "pending")) {
    currentStep = "tool";
    label = latestPipelineSummary.label;
    detail = latestPipelineSummary.detail;
    tone = latestPipelineSummary.tone;
  } else if (latestPendingToolCall || latestToolResult) {
    currentStep = "tool";
    label = latestPendingToolCall ? "工具执行中" : "工具已返回";
    detail = latestPendingToolCall
      ? `正在${formatToolActivityName(toolEventName(latestPendingToolCall))}。`
      : `${formatToolActivityName(toolEventName(latestToolResult!))}已返回，准备继续推进。`;
    tone = latestPendingToolCall ? "accent" : "success";
  } else if ((run.status === "running" || run.status === "pending") && latestThinkingEvent) {
    currentStep = "plan";
    label = "规划下一步";
    detail = "正在理解上下文、选择工具或整理下一步动作。";
    tone = "accent";
  } else if (latestAssistantMessage || run.status === "completed") {
    currentStep = "reply";
    label = run.status === "completed" ? "回复完成" : "整理回复";
    detail = run.status === "completed" ? "本轮运行已经产出回复。" : "正在整理最终输出。";
    tone = run.status === "completed" ? "success" : "accent";
  }

  const stepOrder: RunPhaseStep["key"][] = ["boot", "plan", "tool", "reply"];
  const currentIndex = stepOrder.indexOf(currentStep);
  const steps: RunPhaseStep[] = baseSteps.map((step, index) => ({
    ...step,
    status: index < currentIndex ? "done" : index === currentIndex ? (tone === "warn" || tone === "danger" ? "warn" : "active") : "idle",
  }));
  if (run.status === "completed") {
    steps.forEach((step) => { step.status = "done"; });
  }

  const startedMs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const latestTimestamp = latestEvent?.createdAt ?? run.startedAt ?? null;
  const latestMs = latestTimestamp ? Date.parse(latestTimestamp) : Number.NaN;

  return {
    label,
    detail,
    tone,
    steps,
    elapsedLabel: Number.isFinite(startedMs) ? formatDurationFromMs(Date.now() - startedMs) : null,
    silenceLabel: Number.isFinite(latestMs) ? formatAgeFromTimestamp(latestTimestamp) : null,
    latestEventLabel: latestEvent ? formatEventKindLabel(latestEvent.kind) : null,
  };
}

function computeRunProgressPercent(run: DesktopRun | null, phase: RunPhaseSummary): number {
  if (!run) return 8;
  if (run.status === "completed") return 100;
  if (run.status === "failed" || run.status === "cancelled") return 100;
  if (run.status === "paused") return 76;
  if (run.status === "needs_approval") return 68;

  const activeIndex = phase.steps.findIndex((step) => step.status === "active" || step.status === "warn");
  const total = Math.max(phase.steps.length, 1);
  const base = activeIndex >= 0 ? ((activeIndex + 0.45) / total) * 100 : 12;
  return Math.max(8, Math.min(94, Math.round(base)));
}

function RunLiveReadout({
  run,
  phase,
  activity,
  progressPercent,
}: {
  run: DesktopRun;
  phase: RunPhaseSummary;
  activity: RunActivitySummary;
  progressPercent: number;
}) {
  const status = run.status;
  const isLive = status === "pending" || status === "running";
  const meta = [
    `${Math.round(progressPercent)}%`,
    phase.latestEventLabel ? `最新 ${phase.latestEventLabel}` : null,
    phase.elapsedLabel ? `运行 ${phase.elapsedLabel}` : null,
    phase.silenceLabel ? `静默 ${phase.silenceLabel}` : null,
  ].filter((item): item is string => Boolean(item));
  const detail = activity.stalledDetail ?? activity.detail ?? phase.detail ?? "正在推进当前任务。";
  const label = activity.label || phase.label || formatRunStatus(run.status);

  return (
    <section className={`live-run-readout ${status}${isLive ? " live" : ""}`} aria-live="polite">
      <div className="live-run-readout-main">
        <span className="live-run-orb" aria-hidden="true" />
        <div className="live-run-copy">
          <div className="live-run-line">
            <span className="live-run-label">{label}</span>
            <span className="live-run-chevron">›</span>
            <span className="live-run-detail">{detail}</span>
          </div>
          <div className="live-run-track" aria-label="当前运行进度">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
        {meta.length > 0 ? (
          <div className="live-run-meta">
            {meta.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EventCard({ event }: { event: DesktopEvent }) {
  const { kind, payload, createdAt } = event;
  const p = payload as Record<string, unknown> | undefined;
  const toolName = p?.tool ?? p?.role ?? kind;
  const isObjectPayload = typeof payload === "object" && payload !== null && !(payload as Record<string, unknown>)?.content;
  const lane = eventLane(kind);
  const tone = eventTone(kind);

  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") {
    const requestSummary = summarizeApprovalRequest(p?.request);
    const capability = typeof p?.capability === "string" ? p.capability : "approval";
    const title = kind === "approval_request"
      ? "请求审批"
      : kind === "approval_granted"
        ? "审批通过"
        : "审批拒绝";
    const accent = kind === "approval_denied" ? "#ff6b6b" : kind === "approval_granted" ? "var(--success)" : "#ffb84d";
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone={tone}>{formatEventKindLabel(kind)}</SignalPill>
            <div className="message-meta"><span>{capability}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card" style={{ padding: "10px 12px", background: "rgba(255,184,77,0.08)", borderLeft: `3px solid ${accent}` }}>
            <div className="message-meta" style={{ marginBottom: 6 }}>
              <span>{title}</span>
              <span>{requestSummary.toolName ?? "高风险动作"}</span>
            </div>
            <p className="muted" style={{ marginBottom: 8 }}>
              {requestSummary.reason ? requestSummary.reason : "继续运行前请先审阅这个动作。"}
            </p>
            {requestSummary.toolInput ? <pre className="tool-json">{requestSummary.toolInput.length > 320 ? requestSummary.toolInput.slice(0, 320) + "..." : requestSummary.toolInput}</pre> : null}
          </div>
        </div>
      </article>
    );
  }

  if (kind === "context_compacted") {
    const originalBudget = typeof p?.originalBudget === "number" ? p.originalBudget : null;
    const finalBudget = typeof p?.finalBudget === "number" ? p.finalBudget : null;
    const prunedCount = typeof p?.prunedCount === "number" ? p.prunedCount : 0;
    const compressedCount = typeof p?.compressedCount === "number" ? p.compressedCount : 0;
    const usedLlmCompactor = Boolean(p?.usedLlmCompactor);
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone={tone}>{formatEventKindLabel(kind)}</SignalPill>
            <div className="message-meta"><span>{usedLlmCompactor ? "llm" : "rule"}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card timeline-surface context">
            <p className="muted" style={{ marginBottom: 8 }}>
              {typeof p?.message === "string" ? p.message : "为保持在模型预算内，较早上下文已被压缩。"}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              {originalBudget !== null && finalBudget !== null ? `预算 ~${originalBudget} → ~${finalBudget}` : "预算已调整"}
              {` · 裁剪 ${prunedCount} · 摘要 ${compressedCount}`}
            </p>
          </div>
        </div>
      </article>
    );
  }

  if (kind === "model_usage") {
    const provider = typeof p?.provider === "string" ? p.provider : "provider";
    const model = typeof p?.model === "string" ? p.model : "model";
    const request = typeof p?.request === "number" ? p.request : null;
    const inputTokens = typeof p?.inputTokens === "number" ? p.inputTokens : null;
    const outputTokens = typeof p?.outputTokens === "number" ? p.outputTokens : null;
    const totalTokens = typeof p?.totalTokens === "number" ? p.totalTokens : null;
    const promptEstimateTokens = typeof p?.promptEstimateTokens === "number" ? p.promptEstimateTokens : null;
    const selectedTools = typeof p?.selectedToolSchemaCount === "number" ? p.selectedToolSchemaCount : null;
    const totalTools = typeof p?.totalToolSchemaCount === "number" ? p.totalToolSchemaCount : null;
    const cumulative = typeof p?.cumulativeTotalTokens === "number" ? p.cumulativeTotalTokens : null;
    const cumulativeEstimate = typeof p?.cumulativePromptEstimateTokens === "number" ? p.cumulativePromptEstimateTokens : null;
    const displayedTotal = totalTokens ?? promptEstimateTokens ?? 0;
    const cumulativeTotal = cumulative ?? cumulativeEstimate ?? 0;
    const toolLine = selectedTools !== null && totalTools !== null
      ? `本步只发送 ${selectedTools}/${totalTools} 个工具 schema，减少无关工具定义占用。`
      : "本步使用按需工具 schema，避免每次把所有工具都塞进上下文。";
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone={tone}>{formatEventKindLabel(kind)}</SignalPill>
            <div className="message-meta"><span>{provider}/{model}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card timeline-surface context compact-system-event">
            <p className="muted" style={{ marginBottom: 8 }}>
              第 {request ?? "?"} 次模型请求：本次约 {displayedTotal} token
              {inputTokens !== null ? ` · 输入 ${inputTokens}` : ""}
              {outputTokens !== null ? ` · 输出 ${outputTokens}` : ""}
              {promptEstimateTokens !== null && totalTokens === null ? ` · 上下文估算 ${promptEstimateTokens}` : ""}
              {cumulativeTotal ? `；本轮累计约 ${cumulativeTotal}` : ""}。
            </p>
            <p className="muted" style={{ margin: 0 }}>{toolLine}</p>
          </div>
        </div>
      </article>
    );
  }

  if (isAutoContinuationEvent(event)) {
    const stepBudget = typeof p?.stepBudget === "number" ? p.stepBudget : null;
    const segment = typeof p?.segment === "number" ? p.segment + 1 : null;
    const recentWorkSummary = typeof p?.recentWorkSummary === "string" ? p.recentWorkSummary.trim() : "";
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone="warn">自动续跑</SignalPill>
            <div className="message-meta"><span>动作步，不是 token</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card timeline-surface system compact-system-event">
            <p className="muted">
              {stepBudget ? `${stepBudget} 个动作步用完，` : ""}已进入第 {segment ?? "下一"} 段；自动续跑现在有上限，避免继续烧模型余额。
            </p>
            {recentWorkSummary ? <p className="muted compact-event-detail">最近动作：{truncateInline(recentWorkSummary, 220)}</p> : null}
          </div>
        </div>
      </article>
    );
  }

  if (kind === "tool_call") {
    const toolNameText = typeof p?.tool === "string" ? p.tool : null;
    const summary = summarizeToolActivityDetail(toolNameText, p?.input);
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone={tone}>{formatEventKindLabel(kind)}</SignalPill>
            <div className="message-meta"><span>{String(toolName)}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card timeline-surface tool-call">
            <p className="muted tool-human-summary">准备{formatToolActivityName(toolNameText)}：{summary}</p>
            <pre className="tool-json">{formatPayload(p?.input ?? "")}</pre>
          </div>
        </div>
      </article>
    );
  }

  if (kind === "tool_result") {
    const toolNameText = typeof p?.tool === "string" ? p.tool : null;
    const summary = summarizeToolBlockValue(p?.output);
    const outStr = formatPayload(p?.output);
    const truncated = outStr.length > 500 ? outStr.slice(0, 500) + "..." : outStr;
    return (
      <article className={`timeline-node event lane-${lane}`}>
        <div className="timeline-rail">
          <div className={`timeline-dot ${tone}`} />
        </div>
        <div className="timeline-body">
          <div className="timeline-node-head">
            <SignalPill tone={tone}>{formatEventKindLabel(kind)}</SignalPill>
            <div className="message-meta"><span>{String(toolName)}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
          </div>
          <div className="event-card timeline-surface tool-result">
            <p className="muted tool-human-summary">{formatToolActivityName(toolNameText)}完成：{summary}</p>
            <pre className="tool-json">{truncated}</pre>
          </div>
        </div>
      </article>
    );
  }

  const content = p?.content ?? p?.message ?? (isObjectPayload ? formatPayload(payload) : JSON.stringify(payload));
  return (
    <article className={`timeline-node event lane-${lane}`}>
      <div className="timeline-rail">
        <div className={`timeline-dot ${tone}`} />
      </div>
      <div className="timeline-body">
        <div className="timeline-node-head">
          <SignalPill tone={tone}>{formatEventKindLabel(kind as DesktopEvent["kind"])}</SignalPill>
          <div className="message-meta"><span>{String(toolName)}</span><span>{new Date(createdAt).toLocaleTimeString()}</span></div>
        </div>
        <div className="event-card timeline-surface system">
          <p className="muted">{String(content).slice(0, 300)}</p>
        </div>
      </div>
    </article>
  );
}

function summarizeTimelineEvent(event: DesktopEvent): { title: string; detail: string } {
  if (isAutoContinuationEvent(event)) {
    const payload = eventPayloadRecord(event);
    const stepBudget = typeof payload.stepBudget === "number" ? payload.stepBudget : 72;
    const recentWorkSummary = typeof payload.recentWorkSummary === "string" ? payload.recentWorkSummary.trim() : "";
    return {
      title: "自动续跑",
      detail: recentWorkSummary
        ? `${stepBudget} 个动作步用完，继续下一段。最近动作：${truncateInline(recentWorkSummary, 120)}`
        : `${stepBudget} 个动作步用完，继续下一段；这是动作步预算，不是 token。`,
    };
  }
  if (event.kind === "message") {
    const payload = eventPayloadRecord(event);
    const role = payload.role === "user" ? "输入" : "助手回复";
    return {
      title: role,
      detail: truncateInline(typeof payload.content === "string" ? payload.content : "消息已更新。", 140) || "消息已更新。",
    };
  }
  if (event.kind === "tool_call") {
    return {
      title: `执行 ${toolEventName(event) ?? "tool"}`,
      detail: truncateInline(summarizeToolBlockValue(eventPayloadRecord(event).input), 140) || "工具调用已发出。",
    };
  }
  if (event.kind === "tool_result") {
    return {
      title: `${toolEventName(event) ?? "tool"} 返回`,
      detail: truncateInline(summarizeToolBlockValue(eventPayloadRecord(event).output), 140) || "工具结果已返回。",
    };
  }
  if (event.kind === "model_usage") {
    const payload = eventPayloadRecord(event);
    const provider = typeof payload.provider === "string" ? payload.provider : "provider";
    const model = typeof payload.model === "string" ? payload.model : "model";
    const totalTokens = typeof payload.totalTokens === "number"
      ? payload.totalTokens
      : typeof payload.promptEstimateTokens === "number"
        ? payload.promptEstimateTokens
        : null;
    const selectedTools = typeof payload.selectedToolSchemaCount === "number" ? payload.selectedToolSchemaCount : null;
    const totalTools = typeof payload.totalToolSchemaCount === "number" ? payload.totalToolSchemaCount : null;
    return {
      title: "模型用量",
      detail: `${provider}/${model}${totalTokens !== null ? ` · 本次约 ${totalTokens} token` : ""}${selectedTools !== null && totalTools !== null ? ` · 工具 ${selectedTools}/${totalTools}` : ""}`,
    };
  }
  if (event.kind === "approval_request") {
    const requestSummary = summarizeApprovalRequest(eventPayloadRecord(event).request);
    return {
      title: "等待审批",
      detail: truncateInline(requestSummary.reason ?? requestSummary.toolName ?? "高风险动作等待确认。", 140) || "高风险动作等待确认。",
    };
  }
  if (event.kind === "error") {
    const payload = eventPayloadRecord(event);
    return {
      title: "运行报错",
      detail: truncateInline(typeof payload.message === "string" ? payload.message : "出现错误事件。", 140) || "出现错误事件。",
    };
  }
  return {
    title: formatEventKindLabel(event.kind),
    detail: truncateInline(formatPayload(event.payload), 140) || "事件已更新。",
  };
}

function RunTimeline({ events, streamState }: { events: DesktopEvent[]; streamState: "idle" | "connecting" | "live" | "error" }) {
  const [activeFilter, setActiveFilter] = useState<TimelineLane | "all">("all");
  const [expandedToolBlocks, setExpandedToolBlocks] = useState<Record<string, boolean>>({});
  const [autoFollow, setAutoFollow] = useState(true);
  const [newEventCount, setNewEventCount] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollHostRef = useRef<HTMLElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const latestEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (streamState === "idle") return undefined;
    const timer = window.setInterval(() => setNowTick(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [streamState]);

  const laneCounts = events.reduce<Record<string, number>>((acc, evt) => {
    const lane = eventLane(evt.kind);
    acc[lane] = (acc[lane] ?? 0) + 1;
    return acc;
  }, {});

  const filteredEvents = activeFilter === "all"
    ? events
    : events.filter((evt) => eventLane(evt.kind) === activeFilter);
  const hiddenSourceEventCount = Math.max(0, filteredEvents.length - MAX_TIMELINE_SOURCE_EVENTS);
  const timelineSourceEvents = hiddenSourceEventCount > 0
    ? filteredEvents.slice(-MAX_TIMELINE_SOURCE_EVENTS)
    : filteredEvents;

  const timelineItems: Array<
    | { type: "event"; event: DesktopEvent }
    | { type: "tool_block"; id: string; callEvent: DesktopEvent; resultEvent?: DesktopEvent; pairingMode: "call_id" | "fallback" | "pending" }
  > = [];

  const matchedResultIds = new Set<string>();

  for (let index = 0; index < timelineSourceEvents.length; index += 1) {
    const event = timelineSourceEvents[index];
    if (event.kind === "tool_call") {
      const callToolName = toolEventName(event);
      const callToolCallId = toolEventCallId(event);
      let matchedResultIndex = -1;
      let pairingMode: "call_id" | "fallback" | "pending" = "pending";

      for (let lookahead = index + 1; lookahead < timelineSourceEvents.length; lookahead += 1) {
        const candidate = timelineSourceEvents[lookahead];
        if (candidate.kind !== "tool_result" || matchedResultIds.has(candidate.id)) continue;

        const candidateToolCallId = toolEventCallId(candidate);
        if (callToolCallId && candidateToolCallId === callToolCallId) {
          matchedResultIndex = lookahead;
          pairingMode = "call_id";
          break;
        }

        if (!callToolCallId && !candidateToolCallId && callToolName && toolEventName(candidate) === callToolName) {
          matchedResultIndex = lookahead;
          pairingMode = "fallback";
          break;
        }
      }

      if (matchedResultIndex >= 0) {
        const resultEvent = timelineSourceEvents[matchedResultIndex];
        matchedResultIds.add(resultEvent.id);
        timelineItems.push({
          type: "tool_block",
          id: `${event.id}:${resultEvent.id}`,
          callEvent: event,
          resultEvent,
          pairingMode,
        });
        continue;
      }

      timelineItems.push({ type: "tool_block", id: `${event.id}:pending`, callEvent: event, pairingMode: "pending" });
      continue;
    }
    if (event.kind === "tool_result") {
      if (!matchedResultIds.has(event.id)) {
        timelineItems.push({ type: "event", event });
      }
      continue;
    }
    timelineItems.push({ type: "event", event });
  }

  const hiddenRenderedItemCount = Math.max(0, timelineItems.length - MAX_TIMELINE_RENDER_ITEMS);
  const hiddenTimelineItemCount = hiddenSourceEventCount + hiddenRenderedItemCount;
  const visibleTimelineItems = hiddenRenderedItemCount > 0
    ? timelineItems.slice(-MAX_TIMELINE_RENDER_ITEMS)
    : timelineItems;
  const latestVisibleEvent = filteredEvents[filteredEvents.length - 1] ?? null;
  const latestVisibleSummary = latestVisibleEvent ? summarizeTimelineEvent(latestVisibleEvent) : null;
  const latestVisibleAge = formatAgeFromTimestamp(latestVisibleEvent?.createdAt ?? null, nowTick);
  const latestVisibleItemId = latestVisibleEvent?.id ?? null;

  const scrollToLatest = () => {
    tailRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  useEffect(() => {
    const latestEventId = events[events.length - 1]?.id ?? null;
    if (!latestEventId || latestEventId === latestEventIdRef.current) return;
    latestEventIdRef.current = latestEventId;
    if (autoFollow) {
      setNewEventCount(0);
      requestAnimationFrame(() => {
        tailRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
      });
      return;
    }
    setNewEventCount((prev) => prev + 1);
  }, [autoFollow, events]);

  useEffect(() => {
    if (!autoFollow) return;
    requestAnimationFrame(() => {
      tailRef.current?.scrollIntoView({ block: "end" });
    });
  }, [activeFilter, autoFollow, visibleTimelineItems.length]);

  const handleTimelineScroll = () => {
    const container = scrollHostRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    if (nearBottom) {
      if (!autoFollow) {
        setAutoFollow(true);
        setNewEventCount(0);
      }
      return;
    }
    if (autoFollow) {
      setAutoFollow(false);
    }
  };

  useEffect(() => {
    const host = scrollRef.current?.parentElement;
    if (!host) return undefined;
    scrollHostRef.current = host;
    host.addEventListener("scroll", handleTimelineScroll, { passive: true });
    return () => host.removeEventListener("scroll", handleTimelineScroll);
  });

  if (events.length === 0) {
    return <p className="muted" style={{ padding: 20 }}>还没有运行事件，发一条消息就会开始。</p>;
  }

  return (
    <div className="timeline-stack" ref={scrollRef}>
      <div className="timeline-overview">
        <div className="section-title" style={{ marginBottom: 0 }}>
          <h3>运行时间线</h3>
          <span className="tiny">{filteredEvents.length} / {events.length} 条事件</span>
        </div>
        <div className="timeline-runtime-bar">
          <div className="timeline-runtime-summary">
            <SignalPill tone={streamState === "error" ? "danger" : streamState === "live" ? "success" : streamState === "connecting" ? "warn" : "neutral"}>
              <span className={`timeline-live-dot ${streamState}`} />
              {formatStreamStateLabel(streamState)}
            </SignalPill>
            <SignalPill tone={autoFollow ? "accent" : "neutral"}>{autoFollow ? "跟随最新" : "已暂停跟随"}</SignalPill>
            {newEventCount > 0 ? <SignalPill tone="warn">{newEventCount} 条新事件</SignalPill> : null}
          </div>
          <div className="timeline-runtime-actions">
            <button className={`timeline-follow-btn${autoFollow ? " active" : ""}`} type="button" onClick={() => {
              setAutoFollow(true);
              setNewEventCount(0);
              scrollToLatest();
            }}>
              跟随最新
            </button>
            <button className="timeline-follow-btn" type="button" onClick={() => {
              setNewEventCount(0);
              scrollToLatest();
            }}>
              跳到最新
            </button>
          </div>
        </div>
        {latestVisibleSummary ? (
          <div className="timeline-latest-card">
            <div>
              <span className="tiny">最新事件</span>
              <strong>{latestVisibleSummary.title}</strong>
              <p className="muted">{latestVisibleSummary.detail}</p>
            </div>
            <div className="timeline-latest-meta">
              <span>{latestVisibleAge ?? "刚刚"}</span>
              <span>{new Date(latestVisibleEvent!.createdAt).toLocaleTimeString()}</span>
            </div>
          </div>
        ) : null}
        <div className="timeline-filter-row">
          <button className={`timeline-filter-pill${activeFilter === "all" ? " active" : ""}`} type="button" onClick={() => setActiveFilter("all")}>
            {formatTimelineLaneLabel("all")} · {events.length}
          </button>
          {(Object.entries(laneCounts) as Array<[TimelineLane, number]>).map(([lane, count]) => (
            <button
              key={lane}
              className={`timeline-filter-pill${activeFilter === lane ? " active" : ""}`}
              type="button"
              onClick={() => setActiveFilter(lane)}
            >
              {formatTimelineLaneLabel(lane)} · {count}
            </button>
          ))}
        </div>
        <div className="timeline-lane-pills">
          {Object.entries(laneCounts).map(([lane, count]) => (
            <SignalPill key={lane} tone={lane === "errors" ? "danger" : lane === "approvals" ? "warn" : lane === "tools" ? "accent" : lane === "context" ? "accent" : "neutral"}>
              {formatTimelineLaneLabel(lane)} · {count}
            </SignalPill>
          ))}
        </div>
      </div>

      {timelineItems.length === 0 ? (
        <div className="event-card timeline-surface system">
          <p className="muted">当前筛选下没有事件。</p>
        </div>
      ) : (
        <>
          {hiddenTimelineItemCount > 0 ? (
            <div className="event-card timeline-surface system timeline-omitted-card">
              <p className="muted">
                已折叠较早 {hiddenTimelineItemCount} 个时间线节点，运行中只渲染最近 {MAX_TIMELINE_RENDER_ITEMS} 个以保持界面流畅。
              </p>
            </div>
          ) : null}
          {visibleTimelineItems.map((item) => {
        const isLatestItem = item.type === "tool_block"
          ? item.callEvent.id === latestVisibleItemId || item.resultEvent?.id === latestVisibleItemId
          : item.event.id === latestVisibleItemId;

        if (item.type === "tool_block") {
          const { callEvent, resultEvent, id, pairingMode } = item;
          const callPayload = (callEvent.payload as Record<string, unknown> | undefined) ?? {};
          const resultPayload = (resultEvent?.payload as Record<string, unknown> | undefined) ?? {};
          const toolLabel = String(callPayload.tool ?? callPayload.role ?? "tool");
          const toolNameText = typeof callPayload.tool === "string" ? callPayload.tool : null;
          const inputSummary = summarizeToolActivityDetail(toolNameText, callPayload.input);
          const resultSummary = resultEvent ? summarizeToolBlockValue(resultPayload.output) : "等待中";
          const expanded = Boolean(expandedToolBlocks[id]);
          const pairingLabel = pairingMode === "call_id"
            ? "按 call id 配对"
            : pairingMode === "fallback"
              ? "按工具名配对"
              : "等待结果";
          return (
            <article className={`timeline-node event lane-tools${isLatestItem ? " latest" : ""}`} key={id}>
              <div className="timeline-rail">
                <div className={`timeline-dot accent${isLatestItem ? " pulse" : ""}`} />
              </div>
              <div className="timeline-body">
                <div className="timeline-node-head">
                  <SignalPill tone="accent">执行块</SignalPill>
                  <div className="message-meta"><span>{toolLabel}</span><span>{new Date(callEvent.createdAt).toLocaleTimeString()}</span></div>
                </div>
                <div className="event-card timeline-surface tool-block">
                  <div className="tool-block-head">
                    <div>
                      <strong>{toolLabel}</strong>
                      <p className="muted">
                        {resultEvent
                          ? `${formatToolActivityName(toolNameText)}完成：${resultSummary}`
                          : `准备${formatToolActivityName(toolNameText)}：${inputSummary}`}
                      </p>
                    </div>
                    <div className="tool-block-head-actions">
                      {isLatestItem ? <SignalPill tone="success">最新</SignalPill> : null}
                      <SignalPill tone={pairingMode === "call_id" ? "success" : pairingMode === "fallback" ? "warn" : "neutral"}>{pairingLabel}</SignalPill>
                      <button className="tool-btn" type="button" onClick={() => setExpandedToolBlocks((prev) => ({ ...prev, [id]: !expanded }))}>
                        {expanded ? "收起" : "展开"}
                      </button>
                    </div>
                  </div>
                  <div className="tool-block-summary">
                    <div className="tool-block-chip">
                      <span className="tiny">输入</span>
                      <span className="detail-value">{inputSummary}</span>
                    </div>
                    <div className="tool-block-chip">
                      <span className="tiny">结果</span>
                      <span className="detail-value">{resultSummary}</span>
                    </div>
                  </div>
                  {expanded ? (
                    <div className="tool-block-body">
                      <div>
                        <div className="message-meta"><span>tool_call</span><span>{new Date(callEvent.createdAt).toLocaleTimeString()}</span></div>
                        <pre className="tool-json">{formatPayload(callPayload.input ?? "")}</pre>
                      </div>
                      {resultEvent ? (
                        <div>
                          <div className="message-meta"><span>tool_result</span><span>{new Date(resultEvent.createdAt).toLocaleTimeString()}</span></div>
                          <pre className="tool-json">{formatPayload(resultPayload.output ?? "")}</pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          );
        }

        const evt = item.event;
        if (evt.kind === "message" && (evt.payload as Record<string, unknown>)?.role === "user") {
          return (
            <div className={`timeline-item-shell${isLatestItem ? " latest" : ""}`} key={evt.id}>
              <Message role="user" from="You" time={new Date(evt.createdAt).toLocaleTimeString()}>
                <p>{String((evt.payload as Record<string, unknown>)?.content ?? "")}</p>
              </Message>
            </div>
          );
        }
        if (evt.kind === "message") {
          return (
            <div className={`timeline-item-shell${isLatestItem ? " latest" : ""}`} key={evt.id}>
              <Message from="拾光 Agent" time={new Date(evt.createdAt).toLocaleTimeString()}>
                <p>{String((evt.payload as Record<string, unknown>)?.content ?? "")}</p>
              </Message>
            </div>
          );
        }
        return (
          <div className={`timeline-item-shell${isLatestItem ? " latest" : ""}`} key={evt.id}>
            <EventCard event={evt} />
          </div>
        );
          })}
        </>
      )}
      <div ref={tailRef} />
    </div>
  );
}

function DetailRunRow({
  run,
  active,
  artifactCount,
  branchBusy,
  retryBusy,
  onClick,
  onRetry,
  onBranch,
  onCopyPrompt,
  onShowArtifacts,
}: {
  run: DesktopRun;
  active?: boolean;
  artifactCount?: number;
  branchBusy?: boolean;
  retryBusy?: boolean;
  onClick?: () => void;
  onRetry?: () => void;
  onBranch?: () => void;
  onCopyPrompt?: () => void;
  onShowArtifacts?: () => void;
}) {
  return (
    <div className={`detail-run-row${active ? " active" : ""}`}>
      <button className="detail-run-main" type="button" onClick={onClick}>
        <span className="detail-key">{formatRunStatus(run.status)}</span>
        <span className="detail-value">{run.summary ?? run.id.slice(0, 16)}</span>
      </button>
      <div className="detail-run-actions">
        <button className="tool-btn" type="button" onClick={onShowArtifacts}>产物 {artifactCount ?? 0}</button>
        <button className="tool-btn" type="button" onClick={onCopyPrompt}>复制提示</button>
        <button className="tool-btn" type="button" disabled={branchBusy} onClick={onBranch}>{branchBusy ? "分支中..." : "分支"}</button>
        <button className="tool-btn" type="button" disabled={retryBusy} onClick={onRetry}>{retryBusy ? "重试中..." : "重试"}</button>
      </div>
    </div>
  );
}

function ArtifactCard({
  artifact,
  compact,
  onSelectRun,
  onSelectSession,
  onCopyUri,
  onOpenLocal,
  onRevealLocal,
}: {
  artifact: DesktopArtifact;
  compact?: boolean;
  onSelectRun?: (runId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onCopyUri?: (uri: string) => void;
  onOpenLocal?: (uri: string) => void;
  onRevealLocal?: (uri: string) => void;
}) {
  const summary = typeof artifact.metadata.summary === "string" ? artifact.metadata.summary : artifact.title ?? artifact.kind;
  const stepLabel = typeof artifact.metadata.steps === "number" ? `${artifact.metadata.steps} step(s)` : null;
  const plannerLabel = typeof artifact.metadata.planner === "string" ? artifact.metadata.planner : null;
  const canJumpRun = typeof artifact.runId === "string" && artifact.runId.length > 0;
  const canJumpSession = typeof artifact.sessionId === "string" && artifact.sessionId.length > 0;
  const canOpenHttp = isHttpArtifactUri(artifact.uri);
  const canOpenLocal = isProbablyLocalArtifactUri(artifact.uri);
  const copySummary = async () => {
    await copyTextToClipboard(summary);
  };

  return (
    <div className={`event-card action-card success-card${compact ? " artifact-card-compact" : ""}`}>
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{artifact.title ?? artifact.kind}</span>
        <span>{new Date(artifact.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        {artifact.kind} · {plannerLabel ?? "summary"}{stepLabel ? ` · ${stepLabel}` : ""}
      </p>
      <p className="muted" style={{ marginBottom: 8 }}>{summary.slice(0, compact ? 120 : 220) || "暂无摘要"}</p>
      <div className="artifact-meta-row">
        <SignalPill tone="accent">{compactArtifactUri(artifact.uri)}</SignalPill>
        {artifact.runId ? <SignalPill tone="neutral">run {artifact.runId.slice(0, 8)}</SignalPill> : null}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canJumpSession ? <button className="tool-btn" type="button" onClick={() => onSelectSession?.(artifact.sessionId!)}>打开会话</button> : null}
        {canJumpRun ? <button className="tool-btn" type="button" onClick={() => onSelectRun?.(artifact.runId!)}>定位运行</button> : null}
        {canOpenHttp ? <button className="tool-btn" type="button" onClick={() => window.open(artifact.uri, "_blank", "noopener,noreferrer")}>打开链接</button> : null}
        {canOpenLocal ? <button className="tool-btn" type="button" onClick={() => onOpenLocal?.(artifact.uri)}>打开文件</button> : null}
        {canOpenLocal ? <button className="tool-btn" type="button" onClick={() => onRevealLocal?.(artifact.uri)}>显示位置</button> : null}
        <button className="tool-btn" type="button" onClick={() => { void copySummary(); }}>复制摘要</button>
        <button className="tool-btn" type="button" onClick={() => onCopyUri?.(artifact.uri)}>复制地址</button>
      </div>
    </div>
  );
}

function ApprovalPreviewBlock({ preview }: { preview: ApprovalRequestPreview }) {
  const changeSummary = [
    preview.operation,
    preview.path,
    preview.additions !== null || preview.deletions !== null
      ? `+${preview.additions ?? 0} / -${preview.deletions ?? 0}`
      : null,
    preview.truncated ? "diff 已截断" : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="approval-preview">
      <div className="approval-preview-head">
        <strong>{preview.title}</strong>
        {changeSummary ? <span className="tiny">{changeSummary}</span> : null}
      </div>
      {preview.warnings.length > 0 ? (
        <div className="approval-preview-warnings">
          {preview.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
      {preview.diff ? <pre className="approval-diff">{preview.diff}</pre> : null}
    </div>
  );
}

function ApprovalCard({
  approval,
  decisionState,
  onDecision,
}: {
  approval: DesktopApproval;
  decisionState?: "approving" | "approved" | "denied";
  onDecision: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  const requestSummary = summarizeApprovalRequest(approval.request);
  const deciding = decisionState === "approving";
  const statusLabel = decisionState === "approving"
    ? "处理中"
    : decisionState === "approved"
      ? "已通过"
      : decisionState === "denied"
        ? "已拒绝"
        : approval.status === "pending"
          ? "待处理"
          : approval.status === "granted"
            ? "已通过"
            : approval.status === "denied"
              ? "已拒绝"
              : approval.status === "expired"
                ? "已过期"
                : approval.status;
  return (
    <div className="event-card action-card warn-card approval-card">
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{requestSummary.toolName ?? approval.capability}</span>
        <span>{statusLabel}</span>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        能力 {approval.capability} · 运行 {approval.runId.slice(0, 18)} · 插件 {approval.pluginId}
      </p>
      {requestSummary.reason ? <p className="muted" style={{ marginBottom: 8 }}>{requestSummary.reason}</p> : null}
      {requestSummary.preview ? <ApprovalPreviewBlock preview={requestSummary.preview} /> : null}
      {requestSummary.toolInput ? <pre className="tool-json">{requestSummary.toolInput.length > 320 ? requestSummary.toolInput.slice(0, 320) + "..." : requestSummary.toolInput}</pre> : null}
      {decisionState === "approved" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>已通过，正在恢复运行…</p> : null}
      {decisionState === "denied" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>已拒绝。</p> : null}
      <div className="approval-actions">
        <button className="tool-btn" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "denied")}>拒绝</button>
        <button className="tool-btn primary" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "granted")}>{deciding ? "处理中..." : "通过"}</button>
      </div>
    </div>
  );
}

function ApprovalReceiptCard({
  approval,
  viewState,
}: {
  approval: DesktopApproval;
  viewState: ApprovalViewState;
}) {
  const requestSummary = summarizeApprovalRequest(approval.request);
  const tone: SignalTone = viewState.execution === "failed"
    ? "danger"
    : viewState.status === "denied" || viewState.status === "expired"
      ? "warn"
      : viewState.execution === "executed"
        ? "success"
        : "accent";
  const target = approvalTargetLabel(approval, requestSummary);
  const timeLabel = viewState.updatedAt ? new Date(viewState.updatedAt).toLocaleTimeString() : null;

  return (
    <div className={`approval-receipt-card approval-receipt-${viewState.execution}`}>
      <div className="approval-receipt-head">
        <div>
          <span className="tiny">审批回执</span>
          <h3>{approvalActionLabel(approval, requestSummary)}</h3>
        </div>
        <SignalPill tone={tone}>{viewState.label}</SignalPill>
      </div>
      <p className="muted">{viewState.detail}</p>
      <div className="approval-receipt-meta">
        <span>目标：{target}</span>
        <span>审批：{approval.id.slice(0, 12)}</span>
        {timeLabel ? <span>更新时间：{timeLabel}</span> : null}
      </div>
    </div>
  );
}

function ApprovalReviewCard({
  approval,
  decisionState,
  executionState,
  onDecision,
}: {
  approval: DesktopApproval;
  decisionState?: "approving" | "approved" | "denied";
  executionState?: ApprovalViewState;
  onDecision: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  const requestSummary = summarizeApprovalRequest(approval.request);
  const risk = approvalRiskInfo(approval, requestSummary);
  const rows = approvalScopeRows(approval, requestSummary);
  const checks = approvalSafetyChecks(risk, requestSummary);
  const inputSnippet = compactApprovalInput(requestSummary.toolInput);
  const deciding = decisionState === "approving";
  const resolved = decisionState === "approved"
    || decisionState === "denied"
    || approval.status === "granted"
    || approval.status === "denied"
    || approval.status === "expired";
  const statusLabel = decisionState === "approving"
    ? "正在处理"
    : decisionState === "approved" || approval.status === "granted"
      ? "已通过"
      : decisionState === "denied" || approval.status === "denied"
        ? "已拒绝"
        : approval.status === "expired"
          ? "已过期"
          : "等待确认";

  return (
    <div className={`event-card action-card approval-review-card approval-risk-${risk.level}`}>
      <div className="approval-review-head">
        <div className="approval-review-icon">!</div>
        <div className="approval-review-title">
          <span className="tiny">权限审查 · 单次授权</span>
          <h3>{approvalActionLabel(approval, requestSummary)}</h3>
          <p className="muted">{requestSummary.reason ?? risk.detail}</p>
        </div>
        <div className="approval-review-status">
          <SignalPill tone={risk.tone}>{risk.label}</SignalPill>
          <span className="tiny">{statusLabel}</span>
        </div>
      </div>

      <div className="approval-review-grid">
        {rows.map((row) => (
          <div className="approval-review-cell" key={`${row.label}:${row.value}`}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>

      <div className="approval-review-checks">
        <strong>通过前确认</strong>
        {checks.map((check) => (
          <p key={check}>{check}</p>
        ))}
      </div>

      {requestSummary.preview ? <ApprovalPreviewBlock preview={requestSummary.preview} /> : null}

      {inputSnippet ? (
        <details className="approval-input-details">
          <summary>查看原始工具输入</summary>
          <pre className="tool-json">{inputSnippet}</pre>
        </details>
      ) : null}

      {decisionState === "approved" ? <p className="approval-state-note">已通过，正在恢复运行...</p> : null}
      {decisionState === "denied" ? <p className="approval-state-note">已拒绝，当前运行会停在这里。</p> : null}
      {!decisionState && executionState?.detail ? <p className="approval-state-note">{executionState.detail}</p> : null}

      <div className="approval-actions approval-review-actions">
        <button
          className="tool-btn"
          type="button"
          disabled={deciding || resolved}
          onClick={() => onDecision(approval.id, "denied")}
        >
          拒绝并停止
        </button>
        <button
          className="tool-btn primary"
          type="button"
          disabled={deciding || resolved}
          onClick={() => onDecision(approval.id, "granted")}
        >
          {deciding ? "处理中..." : "通过一次并继续"}
        </button>
      </div>
    </div>
  );
}

function providerDraftFromSettings(settings: DesktopSettings, key: string): ProviderDraft {
  const provider = settings.providers[key] ?? {};
  return {
    key,
    type: provider.type ?? "openai-compatible",
    authMode: provider.authMode ?? "api_key",
    baseURL: provider.baseURL ?? "",
    apiKey: provider.authMode === "none" ? (provider.apiKey ?? "") : "",
    apiKeyMasked: provider.apiKeyMasked ?? "",
    hasStoredApiKey: Boolean(provider.hasStoredApiKey),
    apiKeyEnv: provider.apiKeyEnv ?? "",
    model: provider.model ?? "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
  };
}

function createProviderDraft(key: string): ProviderDraft {
  return {
    key,
    type: "openai-compatible",
    authMode: "api_key",
    baseURL: "",
    apiKey: "",
    apiKeyMasked: "",
    hasStoredApiKey: false,
    apiKeyEnv: "",
    model: "",
    maxTokens: "",
  };
}

function providerCatalogFromSettings(settings: DesktopSettings): Record<string, ProviderDraft> {
  const keys = Object.keys(settings.providers ?? {});
  const providerKeys = keys.length > 0 ? keys : [settings.llm.provider ?? "openai"];
  return Object.fromEntries(providerKeys.map((key) => [key, providerDraftFromSettings(settings, key)]));
}

function buildProviderSettings(draft: ProviderDraft): DesktopSettings["providers"][string] {
  const parsedMaxTokens = draft.maxTokens.trim() ? Number.parseInt(draft.maxTokens, 10) : undefined;
  return {
    type: draft.type,
    authMode: draft.authMode,
    ...(draft.baseURL.trim() ? { baseURL: draft.baseURL.trim() } : {}),
    ...(draft.authMode !== "none" && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.authMode !== "none" && draft.hasStoredApiKey ? { hasStoredApiKey: true } : {}),
    ...(draft.authMode !== "none" && draft.hasStoredApiKey && draft.apiKeyMasked ? { apiKeyMasked: draft.apiKeyMasked } : {}),
    ...(draft.authMode !== "none" && draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
    ...(draft.authMode === "none" && draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
  };
}

function buildSettings(
  base: DesktopSettings,
  providerCatalog: Record<string, ProviderDraft>,
  workspaceRoot: string,
  activeProvider: string,
  activeModel: string,
  maxTokens: string,
  toolApprovalMode: ToolApprovalMode,
): DesktopSettings {
  const parsedMaxTokens = maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined;
  const nextProviders = Object.fromEntries(
    Object.entries(providerCatalog).map(([key, draft]) => [key, buildProviderSettings(draft)]),
  );

  return {
    ...base,
    workspaceRoot: workspaceRoot.trim(),
    toolApprovalMode,
    llm: {
      provider: activeProvider.trim() || "openai",
      ...(activeModel.trim() ? { model: activeModel.trim() } : {}),
      ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
    },
    providers: nextProviders,
  };
}

function buildSessionLlmSettings(provider: string, model: string, maxTokens: string | number | undefined): DesktopSessionLlmSettings | null {
  const cleanProvider = provider.trim();
  const cleanModel = typeof model === "string" ? model.trim() : "";
  const parsedMaxTokens = typeof maxTokens === "number" ? maxTokens : Number.parseInt(String(maxTokens ?? ""), 10);
  const normalizedMaxTokens = Number.isFinite(parsedMaxTokens)
    ? Math.max(256, Math.min(128000, Math.floor(parsedMaxTokens)))
    : undefined;
  const llm: DesktopSessionLlmSettings = {
    ...(cleanProvider ? { provider: cleanProvider } : {}),
    ...(cleanModel ? { model: cleanModel } : {}),
    ...(normalizedMaxTokens ? { maxTokens: normalizedMaxTokens } : {}),
  };
  return Object.keys(llm).length > 0 ? llm : null;
}

function formatMcpServersJson(servers: DesktopSettings["mcpServers"] | undefined): string {
  return JSON.stringify(servers ?? {}, null, 2);
}

function parseMcpServersJson(value: string): DesktopSettings["mcpServers"] {
  const text = value.trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP Servers 必须是一个 JSON 对象");
  }
  return parsed as DesktopSettings["mcpServers"];
}

function providerTone(draft: ProviderDraft): SignalTone {
  if (draft.authMode === "none") return "accent";
  if (draft.apiKey.trim()) return "warn";
  if (draft.hasStoredApiKey) return "success";
  if (draft.apiKeyEnv.trim()) return "warn";
  return "neutral";
}

function providerLabel(draft: ProviderDraft): string {
  if (draft.authMode === "none") return "免鉴权";
  if (draft.apiKey.trim()) return "新 Key";
  if (draft.hasStoredApiKey) return "已存 Key";
  if (draft.apiKeyEnv.trim()) return "环境变量";
  return "未配置";
}

function uniqueProviderKey(existingKeys: string[], baseKey: string): string {
  const normalized = baseKey.trim() || "provider";
  if (!existingKeys.includes(normalized)) return normalized;
  let index = 2;
  while (existingKeys.includes(`${normalized}-${index}`)) {
    index += 1;
  }
  return `${normalized}-${index}`;
}

function normalizeProviderDraftForCompare(draft: ProviderDraft) {
  return {
    key: draft.key,
    type: draft.type,
    authMode: draft.authMode,
    baseURL: draft.baseURL.trim(),
    apiKey: draft.apiKey.trim(),
    apiKeyMasked: draft.apiKeyMasked,
    hasStoredApiKey: draft.hasStoredApiKey,
    apiKeyEnv: draft.apiKeyEnv.trim(),
    model: draft.model.trim(),
    maxTokens: draft.maxTokens.trim(),
  };
}

function formatSettingsValue(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : "—";
}

function normalizePathDisplayValue(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function sameDisplayPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePathDisplayValue(a);
  const right = normalizePathDisplayValue(b);
  return left.length > 0 && left === right;
}

function compactPathTail(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) return "未设置";
  const parts = normalized.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[0] ?? normalized;
}

function isHiddenSessionWorkspace(value: string | null | undefined): boolean {
  return /[\\\/]\.shiguang[\\\/]sessions[\\\/]sess_/i.test(value ?? "");
}

function toolApprovalModeLabel(mode: ToolApprovalMode | undefined): string {
  return mode === "workspace_edits" ? "自动批准工作区文件编辑" : "写文件前需要审批";
}

function summarizeApiKeySource(draft: ProviderDraft): string {
  if (draft.authMode === "none") return "免鉴权";
  if (draft.apiKey.trim()) return "面板新 Key";
  if (draft.hasStoredApiKey) return draft.apiKeyMasked ? `本地已存 ${draft.apiKeyMasked}` : "本地已存 Key";
  if (draft.apiKeyEnv.trim()) return `环境变量 ${draft.apiKeyEnv.trim()}`;
  return "缺失";
}

type SettingsDrawerMode = "full" | "model";

function SettingsDrawer({
  open,
  onClose,
  settings,
  onSaved,
  mode = "full",
  activeSessionId,
  currentSessionWorkspaceRoot,
  currentSessionLlm,
  onSessionWorkspaceChanged,
  onSessionLlmChanged,
}: {
  open: boolean;
  onClose: () => void;
  settings: DesktopSettings | null;
  onSaved: (settings: DesktopSettings) => void;
  mode?: SettingsDrawerMode;
  activeSessionId?: string | null;
  currentSessionWorkspaceRoot?: string | null;
  currentSessionLlm?: DesktopSessionLlmSettings | null;
  onSessionWorkspaceChanged?: () => void | Promise<void>;
  onSessionLlmChanged?: () => void | Promise<void>;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProvider, setActiveProvider] = useState("openai");
  const [activeModel, setActiveModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [toolApprovalMode, setToolApprovalMode] = useState<ToolApprovalMode>("ask");
  const [mcpServersJson, setMcpServersJson] = useState("{}");
  const [providerCatalog, setProviderCatalog] = useState<Record<string, ProviderDraft>>({ openai: createProviderDraft("openai") });
  const [providerKeyInput, setProviderKeyInput] = useState("openai");
  const [providerJsonInput, setProviderJsonInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<DesktopProviderConnectionResult | null>(null);

  const providerOptions = useMemo(() => Object.keys(providerCatalog), [providerCatalog]);
  const providerDraft = providerCatalog[activeProvider] ?? createProviderDraft(activeProvider);
  const fullMode = mode === "full";

  useEffect(() => {
    if (!settings || !open) return;
    const catalog = providerCatalogFromSettings(settings);
    const providerKeys = Object.keys(catalog);
    const preferredProvider = fullMode ? settings.llm.provider : (currentSessionLlm?.provider ?? settings.llm.provider);
    const providerKey = catalog[preferredProvider] ? preferredProvider : (providerKeys[0] ?? "openai");
    setWorkspaceRoot(settings.workspaceRoot ?? "");
    setActiveProvider(providerKey);
    setActiveModel((fullMode ? settings.llm.model : currentSessionLlm?.model) ?? settings.llm.model ?? catalog[providerKey]?.model ?? "");
    const effectiveMaxTokens = fullMode ? settings.llm.maxTokens : currentSessionLlm?.maxTokens;
    setMaxTokens(effectiveMaxTokens
      ? String(effectiveMaxTokens)
      : settings.llm.maxTokens
        ? String(settings.llm.maxTokens)
        : catalog[providerKey]?.maxTokens
        ? String(catalog[providerKey]?.maxTokens)
        : "");
    setToolApprovalMode(settings.toolApprovalMode ?? "ask");
    setMcpServersJson(formatMcpServersJson(settings.mcpServers));
    setProviderCatalog(catalog);
    setProviderKeyInput(providerKey);
    setProviderJsonInput("");
    setSaveState("");
    setConnectionResult(null);
    setShowApiKey(false);
  }, [currentSessionLlm, fullMode, settings, open]);

  if (!open || !settings) return null;

  const patchActiveProvider = (updater: (draft: ProviderDraft) => ProviderDraft) => {
    setProviderCatalog((prev) => ({
      ...prev,
      [activeProvider]: updater(prev[activeProvider] ?? createProviderDraft(activeProvider)),
    }));
  };

  const syncProviderSelection = (nextKey: string, nextDraft?: ProviderDraft) => {
    const draft = nextDraft ?? providerCatalog[nextKey] ?? createProviderDraft(nextKey);
    setActiveProvider(nextKey);
    setProviderKeyInput(nextKey);
    setActiveModel(draft.model || settings.llm.model || "");
    setMaxTokens(draft.maxTokens || (settings.llm.provider === nextKey && settings.llm.maxTokens ? String(settings.llm.maxTokens) : ""));
    setConnectionResult(null);
    setShowApiKey(false);
  };

  const switchProvider = (nextKey: string) => {
    syncProviderSelection(nextKey);
  };

  const renameActiveProvider = () => {
    const nextKey = providerKeyInput.trim();
    if (!nextKey) {
      setProviderKeyInput(activeProvider);
      setSaveState("provider 标识不能为空。");
      return;
    }
    if (nextKey === activeProvider) {
      patchActiveProvider((prev) => ({ ...prev, key: nextKey }));
      return;
    }
    if (providerCatalog[nextKey]) {
      setProviderKeyInput(activeProvider);
      setSaveState(`provider 标识 ${nextKey} 已存在。`);
      return;
    }
    const draft = { ...(providerCatalog[activeProvider] ?? createProviderDraft(activeProvider)), key: nextKey };
    setProviderCatalog((prev) => {
      const next = { ...prev };
      delete next[activeProvider];
      next[nextKey] = draft;
      return next;
    });
    setActiveProvider(nextKey);
    setProviderKeyInput(nextKey);
    setConnectionResult(null);
    setSaveState(`已将 provider ${activeProvider} 重命名为 ${nextKey}，保存后写入配置。`);
  };

  const reorderProviders = (orderedKeys: string[]) => {
    setProviderCatalog((prev) => Object.fromEntries(orderedKeys.map((key) => [key, prev[key] ?? createProviderDraft(key)])));
  };

  const moveProvider = (direction: -1 | 1) => {
    const index = providerOptions.indexOf(activeProvider);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= providerOptions.length) return;
    const orderedKeys = [...providerOptions];
    const [moved] = orderedKeys.splice(index, 1);
    orderedKeys.splice(nextIndex, 0, moved);
    reorderProviders(orderedKeys);
    setSaveState(`已调整 ${activeProvider} 的顺序，保存后写入配置。`);
  };

  const setSelectedAsRuntimeProvider = () => {
    setActiveModel(providerDraft.model || activeModel);
    setMaxTokens(providerDraft.maxTokens || maxTokens);
    setSaveState(`已将运行 Provider 切到 ${activeProvider}，保存后生效。`);
  };

  const resetToPreset = () => {
    const preset = findProviderPreset(activeProvider);
    if (!preset) {
      setSaveState(`当前 provider ${activeProvider} 没有内置预设可恢复。`);
      return;
    }
    const nextDraft = {
      ...preset,
      key: activeProvider,
      apiKey: "",
      apiKeyMasked: providerDraft.apiKeyMasked,
      hasStoredApiKey: providerDraft.hasStoredApiKey,
    };
    setProviderCatalog((prev) => ({ ...prev, [activeProvider]: nextDraft }));
    setActiveModel(preset.model);
    setMaxTokens(preset.maxTokens);
    setConnectionResult(null);
    setSaveState(`已将 ${activeProvider} 恢复到内置预设。`);
  };

  const exportProviderJson = async () => {
    const payload = JSON.stringify({
      activeProvider,
      runtime: {
        workspaceRoot,
        model: activeModel,
        maxTokens,
        toolApprovalMode,
      },
      provider: normalizeProviderDraftForCompare(providerDraft),
    }, null, 2);
    setProviderJsonInput(payload);
    try {
      await copyTextToClipboard(payload);
      setSaveState(`已导出 ${activeProvider} 配置 JSON，并复制到剪贴板。`);
    } catch {
      setSaveState(`已导出 ${activeProvider} 配置 JSON。当前环境不支持自动复制，可手动复制下方文本。`);
    }
  };

  const importProviderJson = () => {
    try {
      const parsed = JSON.parse(providerJsonInput) as {
        activeProvider?: string;
        runtime?: { workspaceRoot?: string; model?: string; maxTokens?: string | number; toolApprovalMode?: ToolApprovalMode };
        provider?: Partial<ProviderDraft>;
      };
      const targetKey = (parsed.activeProvider ?? parsed.provider?.key ?? activeProvider).trim();
      if (!targetKey) throw new Error("缺少 activeProvider / provider.key");
      const existing = providerCatalog[targetKey] ?? createProviderDraft(targetKey);
      const nextDraft: ProviderDraft = {
        ...existing,
        ...parsed.provider,
        key: targetKey,
        apiKey: typeof parsed.provider?.apiKey === "string" ? parsed.provider.apiKey : existing.apiKey,
        apiKeyMasked: typeof parsed.provider?.apiKeyMasked === "string" ? parsed.provider.apiKeyMasked : existing.apiKeyMasked,
        hasStoredApiKey: typeof parsed.provider?.hasStoredApiKey === "boolean" ? parsed.provider.hasStoredApiKey : existing.hasStoredApiKey,
        apiKeyEnv: typeof parsed.provider?.apiKeyEnv === "string" ? parsed.provider.apiKeyEnv : existing.apiKeyEnv,
        model: typeof parsed.provider?.model === "string" ? parsed.provider.model : existing.model,
        maxTokens: parsed.provider?.maxTokens !== undefined ? String(parsed.provider.maxTokens) : existing.maxTokens,
      };
      setProviderCatalog((prev) => ({ ...prev, [targetKey]: nextDraft }));
      syncProviderSelection(targetKey, nextDraft);
      if (typeof parsed.runtime?.workspaceRoot === "string") setWorkspaceRoot(parsed.runtime.workspaceRoot);
      if (typeof parsed.runtime?.model === "string") setActiveModel(parsed.runtime.model);
      if (parsed.runtime?.maxTokens !== undefined) setMaxTokens(String(parsed.runtime.maxTokens));
      if (parsed.runtime?.toolApprovalMode === "ask" || parsed.runtime?.toolApprovalMode === "workspace_edits") {
        setToolApprovalMode(parsed.runtime.toolApprovalMode);
      }
      setSaveState(`已导入 ${targetKey} 配置 JSON，保存后写入配置文件。`);
    } catch (error) {
      setSaveState(error instanceof Error ? `导入失败：${error.message}` : `导入失败：${String(error)}`);
    }
  };

  const addProvider = () => {
    const nextKey = uniqueProviderKey(providerOptions, "provider");
    const nextDraft = createProviderDraft(nextKey);
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState("已创建新的 provider 草稿，填完后保存即可写入配置。");
  };

  const duplicateProvider = () => {
    const nextKey = uniqueProviderKey(providerOptions, providerDraft.key || activeProvider);
    const nextDraft = {
      ...providerDraft,
      key: nextKey,
      apiKey: "",
      apiKeyMasked: providerDraft.apiKeyMasked,
      hasStoredApiKey: providerDraft.hasStoredApiKey,
    };
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState(`已基于 ${activeProvider} 复制出 ${nextKey}。`);
  };

  const removeProvider = () => {
    if (providerOptions.length <= 1) return;
    const nextKeys = providerOptions.filter((key) => key !== activeProvider);
    const fallbackKey = nextKeys[0] ?? "openai";
    setProviderCatalog((prev) => {
      const next = { ...prev };
      delete next[activeProvider];
      return next;
    });
    syncProviderSelection(fallbackKey, providerCatalog[fallbackKey]);
    setSaveState(`已从注册表移除 ${activeProvider}，保存后会同步到配置文件。`);
  };

  const resetProviderDraft = () => {
    const nextDraft = settings.providers[activeProvider]
      ? providerDraftFromSettings(settings, activeProvider)
      : createProviderDraft(activeProvider);
    setProviderCatalog((prev) => ({ ...prev, [activeProvider]: nextDraft }));
    setActiveModel(settings.llm.provider === activeProvider ? (settings.llm.model ?? nextDraft.model ?? "") : nextDraft.model);
    setMaxTokens(settings.llm.provider === activeProvider
      ? (settings.llm.maxTokens ? String(settings.llm.maxTokens) : nextDraft.maxTokens)
      : nextDraft.maxTokens);
    setConnectionResult(null);
    setShowApiKey(false);
    setSaveState(`已重置 ${activeProvider} 到最近保存状态。`);
  };

  const clearStoredApiKey = () => {
    patchActiveProvider((prev) => ({
      ...prev,
      apiKey: "",
      apiKeyMasked: "",
      hasStoredApiKey: false,
      apiKeyEnv: "",
    }));
    setConnectionResult(null);
    setSaveState(`已清空 ${activeProvider} 的 Key 来源，保存后生效。`);
  };

  const applyPreset = (draft: ProviderDraft) => {
    const nextKey = providerOptions.includes(draft.key) ? draft.key : uniqueProviderKey(providerOptions, draft.key);
    const nextDraft = { ...draft, key: nextKey };
    setProviderCatalog((prev) => ({ ...prev, [nextKey]: nextDraft }));
    syncProviderSelection(nextKey, nextDraft);
    setSaveState(`已加载 ${nextKey} 预设，保存后写入配置。`);
  };

  const buildConnectionRequest = () => ({
    providerKey: activeProvider || providerDraft.key || "openai",
    provider: {
      ...buildProviderSettings(providerDraft),
      model: (activeModel || providerDraft.model).trim(),
      maxTokens: maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined,
    },
  });

  const runConnectionTest = async () => {
    try {
      const result = await requireDesktopBridge().testProviderConnection(buildConnectionRequest());
      setConnectionResult(result);
      return result;
    } catch (error) {
      const fallbackResult: DesktopProviderConnectionResult = {
        ok: false,
        providerKey: activeProvider || "openai",
        providerType: providerDraft.type,
        authSource: providerDraft.authMode === "none" ? "none" : "missing",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
      setConnectionResult(fallbackResult);
      return fallbackResult;
    }
  };

  const save = async () => {
    setSaving(true);
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const workspaceChanged = fullMode && workspaceRoot.trim() !== (settings.workspaceRoot ?? "");
      const mcpServers = fullMode ? parseMcpServersJson(mcpServersJson) : settings.mcpServers;
      const globalModel = settings.llm.model ?? "";
      const globalMaxTokens = settings.llm.maxTokens ? String(settings.llm.maxTokens) : "";
      const next = {
        ...buildSettings(
          settings,
          providerCatalog,
          fullMode ? workspaceRoot : settings.workspaceRoot,
          fullMode ? activeProvider : (settings.llm.provider ?? "openai"),
          fullMode ? activeModel : globalModel,
          fullMode ? maxTokens : globalMaxTokens,
          fullMode ? toolApprovalMode : (settings.toolApprovalMode ?? "ask"),
        ),
        mcpServers,
      };
      const bridge = requireDesktopBridge();
      const saved = await bridge.saveSettings(next);
      onSaved(saved);
      if (!fullMode && activeSessionId) {
        await bridge.updateSessionLlm({
          sessionId: activeSessionId,
          llm: buildSessionLlmSettings(activeProvider, activeModel, maxTokens),
        });
        await onSessionLlmChanged?.();
      }
      const shouldSyncCurrentSessionWorkspace = fullMode
        && Boolean(activeSessionId)
        && Boolean(saved.workspaceRoot.trim())
        && (workspaceChanged || !sameDisplayPath(currentSessionWorkspaceRoot, saved.workspaceRoot));
      if (shouldSyncCurrentSessionWorkspace && activeSessionId && saved.workspaceRoot.trim()) {
        await bridge.updateSessionWorkspace({ sessionId: activeSessionId, workspaceRoot: saved.workspaceRoot });
        await onSessionWorkspaceChanged?.();
      }
      const testResult = await runConnectionTest();
      setSaveState(`已保存到 ${saved.configPath} · ${testResult.ok ? "连接成功" : "连接失败"}`);
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
      setTestingConnection(false);
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      await runConnectionTest();
    } finally {
      setTestingConnection(false);
    }
  };

  const connectionLabel = connectionResult ? (connectionResult.ok ? "已连通" : "失败") : providerLabel(providerDraft);
  const activeProviderModelOptions = modelOptionsForProvider(activeProvider, providerDraft);
  const authSummary = providerDraft.authMode === "none"
    ? "当前 provider 不要求 API Key。"
    : providerDraft.apiKey.trim()
      ? "优先使用当前面板里填写的新 API Key。"
      : providerDraft.hasStoredApiKey
        ? `当前已保存 API Key：${providerDraft.apiKeyMasked || "已保存"}。留空即继续使用它。`
        : providerDraft.apiKeyEnv.trim()
          ? `将读取环境变量 ${providerDraft.apiKeyEnv.trim()}。`
          : "还没有可用的 API Key 来源。";
  const connectionFeedbackClass = testingConnection
    ? "testing"
    : connectionResult
      ? (connectionResult.ok ? "success" : "danger")
      : "idle";
  const connectionFeedbackTitle = testingConnection
    ? "正在测试连接"
    : connectionResult
      ? (connectionResult.ok ? "连接成功" : "连接失败")
      : "尚未测试连接";
  const connectionFeedbackDetail = testingConnection
    ? `正在使用 ${activeProvider} / ${activeModel || providerDraft.model || "未设置模型"} 发起测试请求。`
    : connectionResult?.detail ?? authSummary;
  const selectedSavedDraft = settings.providers[activeProvider]
    ? providerDraftFromSettings(settings, activeProvider)
    : createProviderDraft(activeProvider);
  const providerDirty = JSON.stringify(normalizeProviderDraftForCompare(providerDraft)) !== JSON.stringify(normalizeProviderDraftForCompare(selectedSavedDraft));
  const savedRuntimeProvider = fullMode ? (settings.llm.provider ?? "openai") : (currentSessionLlm?.provider ?? settings.llm.provider ?? "openai");
  const savedRuntimeModel = fullMode ? (settings.llm.model ?? "") : (currentSessionLlm?.model ?? settings.llm.model ?? "");
  const savedRuntimeMaxTokens = fullMode
    ? (settings.llm.maxTokens ? String(settings.llm.maxTokens) : "")
    : (currentSessionLlm?.maxTokens ? String(currentSessionLlm.maxTokens) : (settings.llm.maxTokens ? String(settings.llm.maxTokens) : ""));
  const runtimeDirty = activeProvider !== savedRuntimeProvider
    || activeModel.trim() !== savedRuntimeModel
    || maxTokens.trim() !== savedRuntimeMaxTokens
    || (fullMode && workspaceRoot.trim() !== (settings.workspaceRoot ?? ""))
    || (fullMode && toolApprovalMode !== (settings.toolApprovalMode ?? "ask"))
    || (fullMode && mcpServersJson.trim() !== formatMcpServersJson(settings.mcpServers).trim());
  const effectiveModelSource = activeModel.trim()
    ? "当前配置 llm.model"
    : providerDraft.model.trim()
      ? `provider 默认模型 · ${providerDraft.model.trim()}`
      : "未设置";
  const effectiveMaxTokensSource = maxTokens.trim()
    ? "当前配置 llm.maxTokens"
    : providerDraft.maxTokens.trim()
      ? `provider 默认 maxTokens · ${providerDraft.maxTokens.trim()}`
      : "运行时默认值";

  const applyProviderModelOption = (option: ProviderModelOption) => {
    setActiveModel(option.value);
    if (fullMode) {
      patchActiveProvider((prev) => ({ ...prev, model: option.value }));
    }
    setSaveState(fullMode
      ? `已切换到 ${option.label}（${option.value}），保存后作为全局默认生效。`
      : `已切换到 ${option.label}（${option.value}），保存后只对当前会话生效。`);
  };

  const providerDiffItems = [
    { label: "provider 标识", current: activeProvider, saved: selectedSavedDraft.key },
    { label: "协议", current: providerDraft.type, saved: selectedSavedDraft.type },
    { label: "鉴权方式", current: providerDraft.authMode, saved: selectedSavedDraft.authMode },
    { label: "Base URL", current: formatSettingsValue(providerDraft.baseURL), saved: formatSettingsValue(selectedSavedDraft.baseURL) },
    { label: "API Key 来源", current: summarizeApiKeySource(providerDraft), saved: summarizeApiKeySource(selectedSavedDraft) },
    { label: "API Key 环境变量", current: formatSettingsValue(providerDraft.apiKeyEnv), saved: formatSettingsValue(selectedSavedDraft.apiKeyEnv) },
    { label: "默认模型", current: formatSettingsValue(providerDraft.model), saved: formatSettingsValue(selectedSavedDraft.model) },
  ].filter((item) => item.current !== item.saved);
  const runtimeDiffItems = [
    { label: "默认工作目录", current: formatSettingsValue(workspaceRoot), saved: formatSettingsValue(settings.workspaceRoot) },
    { label: "当前 Provider", current: activeProvider, saved: savedRuntimeProvider },
    { label: "运行模型", current: formatSettingsValue(activeModel), saved: formatSettingsValue(savedRuntimeModel) },
    { label: "运行 maxTokens", current: formatSettingsValue(maxTokens), saved: formatSettingsValue(savedRuntimeMaxTokens) },
    { label: "工具审批", current: toolApprovalModeLabel(toolApprovalMode), saved: toolApprovalModeLabel(settings.toolApprovalMode ?? "ask") },
  ].filter((item) => item.current !== item.saved);
  const visibleRuntimeDiffItems = fullMode ? runtimeDiffItems : runtimeDiffItems.slice(1, 4);

  if (!fullMode) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
        <aside className="panel settings-drawer settings-drawer-model-only">
          <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
            <div className="title-group">
              <h2>当前会话模型</h2>
              <p>Provider、模型和 maxTokens 只对当前会话生效；API 连接配置会保存到本机 provider。</p>
            </div>
            <div className="toolbar">
              <ToolBtn onClick={onClose}>关闭</ToolBtn>
              <ToolBtn primary onClick={save}>{saving ? "保存中..." : "保存当前会话"}</ToolBtn>
            </div>
          </div>

          <div className="settings-summary-grid">
            <div className="settings-summary-card">
              <span className="tiny">当前运行</span>
              <strong>{settings.llm.provider || activeProvider}</strong>
              <p className="muted">{settings.llm.model || providerDraft.model || "未固定模型"}</p>
            </div>
            <div className="settings-summary-card">
              <span className="tiny">正在编辑</span>
              <strong>{activeProvider}</strong>
              <p className="muted">{activeModel || providerDraft.model || "未设置模型"}</p>
            </div>
            <div className="settings-summary-card">
              <span className="tiny">连接状态</span>
              <strong>{connectionLabel}</strong>
              <p className="muted">{connectionResult?.detail ?? "保存前可先测试 provider 连接。"}</p>
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>选择 Provider</h3><span className="tiny">{providerOptions.length} 个来源</span></div>
            <div className="provider-registry-grid">
              {providerOptions.map((key) => {
                const draft = providerCatalog[key];
                const selected = key === activeProvider;
                const runtimeActive = key === settings.llm.provider;
                return (
                  <button
                    key={key}
                    className={`provider-registry-item${selected ? " active" : ""}`}
                    type="button"
                    onClick={() => switchProvider(key)}
                  >
                    <div className="provider-registry-head">
                      <strong>{key}</strong>
                      <SignalPill tone={providerTone(draft)}>{providerLabel(draft)}</SignalPill>
                    </div>
                    <p>{draft.model || "未设默认模型"}</p>
                    <div className="provider-meta-row">
                      <span>{draft.type}</span>
                      {runtimeActive ? <span>当前运行</span> : null}
                      {selected ? <span>正在编辑</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>模型</h3><span className="tiny">{activeProvider}</span></div>
            <div className="settings-inline-grid">
              <div>
                <label className="tiny">Provider</label>
                <select className="settings-input" value={activeProvider} onChange={(e) => switchProvider(e.target.value)}>
                  {providerOptions.map((key) => (
                    <option key={`model-provider-${key}`} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="tiny">运行模型</label>
                <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-v4-flash / gpt-5 / openai/gpt-5" />
                {activeProviderModelOptions.length > 0 ? (
                  <div className="provider-action-row provider-action-row-tight model-preset-row">
                    {activeProviderModelOptions.map((option) => (
                      <button
                        key={`model-only-${option.value}`}
                        className={`tool-btn${activeModel.trim() === option.value ? " primary" : ""}`}
                        type="button"
                        title={option.hint}
                        onClick={() => applyProviderModelOption(option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div>
                <label className="tiny">最大 Tokens</label>
                <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
              </div>
            </div>
            <p className="muted" style={{ margin: 0 }}>{connectionResult?.detail ?? authSummary}</p>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>API 设置</h3><span className="tiny">只影响当前 Provider，不修改工作区</span></div>
            <div className="settings-inline-grid">
              <div>
                <label className="tiny">协议</label>
                <select className="settings-input" value={providerDraft.type} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
                  <option value="openai-compatible">openai-compatible</option>
                  <option value="anthropic">anthropic</option>
                  <option value="gemini">gemini</option>
                </select>
              </div>
              <div>
                <label className="tiny">鉴权方式</label>
                <select className="settings-input" value={providerDraft.authMode} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
                  <option value="api_key">api_key</option>
                  <option value="none">none</option>
                </select>
              </div>
            </div>
            <div>
              <label className="tiny">Base URL</label>
              <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div>
              <label className="tiny">API Key</label>
              <div className="settings-inline-grid settings-inline-grid-tight">
                <input
                  className="settings-input"
                  type={showApiKey ? "text" : "password"}
                  value={providerDraft.apiKey}
                  onChange={(e) => patchActiveProvider((prev) => ({
                    ...prev,
                    apiKey: e.target.value,
                    apiKeyMasked: e.target.value.trim() ? "" : prev.apiKeyMasked,
                    hasStoredApiKey: e.target.value.trim() ? false : prev.hasStoredApiKey,
                  }))}
                  placeholder={providerDraft.authMode === "none"
                    ? "可留空"
                    : providerDraft.hasStoredApiKey
                      ? `已保存 ${providerDraft.apiKeyMasked || "API Key"}；留空则保持不变`
                      : "sk-... / 直接填入本地配置"}
                  disabled={providerDraft.authMode === "none"}
                />
                <div className="provider-action-row provider-action-row-tight">
                  <ToolBtn onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? "隐藏" : "显示"}</ToolBtn>
                  <ToolBtn onClick={clearStoredApiKey}>清空来源</ToolBtn>
                </div>
              </div>
            </div>
            <div>
              <label className="tiny">API Key 环境变量</label>
              <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "不需要" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
            </div>
            <div className={`provider-test-panel ${connectionFeedbackClass}`}>
              <div>
                <span className="tiny">连接测试</span>
                <strong>{connectionFeedbackTitle}</strong>
                <p>{connectionFeedbackDetail}</p>
              </div>
              <ToolBtn onClick={() => { void testConnection(); }}>{testingConnection ? "测试中..." : "测试连接"}</ToolBtn>
            </div>
          </div>

          <div className="detail-block settings-section-stack">
            <div className="section-title"><h4>待保存差异</h4><span className="tiny">{providerDiffItems.length + visibleRuntimeDiffItems.length} 项变更</span></div>
            {providerDiffItems.length + visibleRuntimeDiffItems.length > 0 ? (
              <div className="settings-diff-list">
                {visibleRuntimeDiffItems.map((item) => (
                  <div key={`model-runtime-${item.label}`} className="settings-diff-item">
                    <span className="tiny">运行配置 · {item.label}</span>
                    <div className="settings-diff-values">
                      <span>{item.saved}</span>
                      <strong>→</strong>
                      <span>{item.current}</span>
                    </div>
                  </div>
                ))}
                {providerDiffItems.map((item) => (
                  <div key={`model-provider-${item.label}`} className="settings-diff-item">
                    <span className="tiny">Provider · {item.label}</span>
                    <div className="settings-diff-values">
                      <span>{item.saved}</span>
                      <strong>→</strong>
                      <span>{item.current}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">模型配置没有待保存变更。</p>
            )}
            {saveState ? <p className="muted">{saveState}</p> : null}
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
      <aside className="panel settings-drawer settings-drawer-simple">
        <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
          <div className="title-group">
            <h2>设置</h2>
            <p>常用项只保留默认工作区、默认模型和 API；Provider/MCP 等放在高级区。</p>
          </div>
          <div className="toolbar">
            <ToolBtn onClick={onClose}>关闭</ToolBtn>
            <ToolBtn primary onClick={save}>{saving ? "保存中..." : "保存"}</ToolBtn>
          </div>
        </div>

        <div className="settings-summary-grid">
          <div className="settings-summary-card">
            <span className="tiny">当前运行 Provider</span>
            <strong>{settings.llm.provider || activeProvider}</strong>
            <p className="muted">运行模型：{settings.llm.model || "未固定"}</p>
          </div>
          <div className="settings-summary-card">
            <span className="tiny">选中条目</span>
            <strong>{activeProvider}</strong>
            <p className="muted">{providerDraft.model || "未设默认模型"}</p>
          </div>
          <div className="settings-summary-card">
            <span className="tiny">注册表规模</span>
            <strong>{providerOptions.length} 个 provider</strong>
            <p className="muted">{providerDirty ? "当前条目有未保存变更" : "当前条目与已保存配置一致"}</p>
          </div>
        </div>

        <details className="settings-advanced">
          <summary>高级 Provider 管理</summary>
          <div className="detail-block settings-section-stack">
            <div className="section-title"><h3>Provider 工作台</h3><span className="tiny">选择、重命名、复制、删除、预设导入</span></div>
          <div className="provider-rename-row">
            <input
              className="settings-input"
              value={providerKeyInput}
              onChange={(e) => setProviderKeyInput(e.target.value)}
              onBlur={renameActiveProvider}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  renameActiveProvider();
                }
              }}
              placeholder="provider 标识"
            />
            <div className="provider-action-row">
              <ToolBtn onClick={renameActiveProvider}>重命名</ToolBtn>
              <ToolBtn onClick={() => moveProvider(-1)}>上移</ToolBtn>
              <ToolBtn onClick={() => moveProvider(1)}>下移</ToolBtn>
              <ToolBtn onClick={addProvider}>新增空白</ToolBtn>
              <ToolBtn onClick={duplicateProvider}>复制当前</ToolBtn>
              <ToolBtn onClick={resetProviderDraft}>恢复已保存</ToolBtn>
              <ToolBtn onClick={resetToPreset}>恢复预设</ToolBtn>
              <ToolBtn onClick={removeProvider}>删除当前</ToolBtn>
            </div>
          </div>
          <div className="provider-registry-grid">
            {providerOptions.map((key) => {
              const draft = providerCatalog[key];
              const selected = key === activeProvider;
              const runtimeActive = key === settings.llm.provider;
              return (
                <button
                  key={key}
                  className={`provider-registry-item${selected ? " active" : ""}`}
                  type="button"
                  onClick={() => switchProvider(key)}
                >
                  <div className="provider-registry-head">
                    <strong>{key}</strong>
                    <SignalPill tone={providerTone(draft)}>{providerLabel(draft)}</SignalPill>
                  </div>
                  <p>{draft.model || "未设默认模型"}</p>
                  <div className="provider-meta-row">
                    <span>{draft.type}</span>
                    <span>{draft.baseURL || "未设 Base URL"}</span>
                    {runtimeActive ? <span>当前运行</span> : null}
                    {selected ? <span>正在编辑</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
          </div>
        </details>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>当前配置</h3><span className="tiny">{settings.configPath}</span></div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">默认工作目录</label>
              <input className="settings-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
              <p className="muted" style={{ margin: "8px 0 0" }}>
                新会话会从这里开始；当前会话如已切换项目目录，会优先使用自己的会话目录。
              </p>
            </div>
            <div>
              <label className="tiny">当前 Provider</label>
              <div className="settings-chip-row">
                <SignalPill tone="accent">{activeProvider}</SignalPill>
                {activeProvider === settings.llm.provider ? <SignalPill tone="success">运行中</SignalPill> : <SignalPill tone="neutral">保存后切换</SignalPill>}
                {activeProvider !== settings.llm.provider ? <ToolBtn onClick={setSelectedAsRuntimeProvider}>设为当前运行</ToolBtn> : null}
              </div>
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">模型</label>
              <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-v4-flash / gpt-5 / openai/gpt-5" />
              {activeProviderModelOptions.length > 0 ? (
                <div className="provider-action-row provider-action-row-tight model-preset-row">
                  {activeProviderModelOptions.map((option) => (
                    <button
                      key={`runtime-${option.value}`}
                      className={`tool-btn${activeModel.trim() === option.value ? " primary" : ""}`}
                      type="button"
                      title={option.hint}
                      onClick={() => applyProviderModelOption(option)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <label className="tiny">最大 Tokens</label>
              <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">工具审批</label>
              <select className="settings-input" value={toolApprovalMode} onChange={(e) => setToolApprovalMode(e.target.value as ToolApprovalMode)}>
                <option value="ask">写文件前需要审批</option>
                <option value="workspace_edits">自动批准工作区文件编辑</option>
              </select>
            </div>
            <div>
              <label className="tiny">自动批准范围</label>
              <p className="muted" style={{ margin: 0 }}>
                {toolApprovalMode === "workspace_edits"
                  ? "只自动放行 write_text_file / patch_text_file；终端、删除、移动仍然需要审批。"
                  : "写入、终端、删除、移动等高风险工具都会先生成审批卡片。"}
              </p>
            </div>
          </div>
          <details className="settings-nested-advanced">
            <summary>MCP 工具服务器（高级）</summary>
            <div>
              <textarea
                className="settings-input"
                value={mcpServersJson}
                onChange={(e) => setMcpServersJson(e.target.value)}
                rows={7}
                spellCheck={false}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", resize: "vertical" }}
                placeholder={'{\n  "filesystem": {\n    "transport": "stdio",\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "G:/projects"]\n  }\n}'}
              />
              <p className="muted" style={{ margin: "8px 0 0" }}>
                配置 stdio MCP server。保存后，新运行会自动通过 tools/list 发现工具，并按读/写/执行风险接入审批。
              </p>
            </div>
          </details>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>Provider 注册表</h3><span className="tiny">{activeProvider}</span></div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">协议</label>
              <select className="settings-input" value={providerDraft.type} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
                <option value="openai-compatible">openai-compatible</option>
                <option value="anthropic">anthropic</option>
                <option value="gemini">gemini</option>
              </select>
            </div>
            <div>
              <label className="tiny">鉴权方式</label>
              <select className="settings-input" value={providerDraft.authMode} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
                <option value="api_key">api_key</option>
                <option value="none">none</option>
              </select>
            </div>
          </div>
          <div>
            <label className="tiny">Base URL</label>
            <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
          </div>
          <div>
            <label className="tiny">API Key</label>
            <div className="settings-inline-grid settings-inline-grid-tight">
              <input
                className="settings-input"
                type={showApiKey ? "text" : "password"}
                value={providerDraft.apiKey}
                onChange={(e) => patchActiveProvider((prev) => ({
                  ...prev,
                  apiKey: e.target.value,
                  apiKeyMasked: e.target.value.trim() ? "" : prev.apiKeyMasked,
                  hasStoredApiKey: e.target.value.trim() ? false : prev.hasStoredApiKey,
                }))}
                placeholder={providerDraft.authMode === "none"
                  ? "可留空"
                  : providerDraft.hasStoredApiKey
                    ? `已保存 ${providerDraft.apiKeyMasked || "API Key"}；留空则保持不变`
                    : "sk-... / 直接填入本地配置"}
                disabled={providerDraft.authMode === "none"}
              />
              <div className="provider-action-row provider-action-row-tight">
                <ToolBtn onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? "隐藏" : "显示"}</ToolBtn>
                <ToolBtn onClick={clearStoredApiKey}>清空来源</ToolBtn>
              </div>
            </div>
          </div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">API Key 环境变量</label>
              <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "不需要" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
            </div>
            <div>
              <label className="tiny">默认模型</label>
              <input className="settings-input" value={providerDraft.model} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, model: e.target.value }))} placeholder="deepseek-v4-flash" />
              {activeProviderModelOptions.length > 0 ? (
                <div className="provider-action-row provider-action-row-tight model-preset-row">
                  {activeProviderModelOptions.map((option) => (
                    <button
                      key={`provider-${option.value}`}
                      className={`tool-btn${providerDraft.model.trim() === option.value ? " primary" : ""}`}
                      type="button"
                      title={option.hint}
                      onClick={() => applyProviderModelOption(option)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {activeProviderModelOptions.length > 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              DeepSeek 官方新模型为 <code>deepseek-v4-flash</code> 和 <code>deepseek-v4-pro</code>；旧 <code>deepseek-chat</code> / <code>deepseek-reasoner</code> 仅作为兼容入口保留。
            </p>
          ) : null}
          <div>
            <label className="tiny">说明</label>
            <div className="detail-row" style={{ justifyContent: "flex-start" }}>
              <span className="detail-value" style={{ textAlign: "left" }}>{CODEX_PROVIDER_HINT}</span>
            </div>
          </div>
          <div className={`provider-test-panel ${connectionFeedbackClass}`}>
            <div>
              <span className="tiny">连接测试</span>
              <strong>{connectionFeedbackTitle}</strong>
              <p>{connectionFeedbackDetail}</p>
            </div>
            <ToolBtn onClick={() => { void testConnection(); }}>{testingConnection ? "测试中..." : "测试连接"}</ToolBtn>
          </div>
        </div>

        <details className="settings-advanced">
          <summary>高级信息、预设与迁移</summary>
        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>生效来源</h4><span className="tiny">当前运行到底会吃哪一层配置</span></div>
          <div className="settings-source-grid">
            <div className="settings-source-card">
              <span className="tiny">API Key</span>
              <strong>{summarizeApiKeySource(providerDraft)}</strong>
              <p className="muted">{authSummary}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">运行模型</span>
              <strong>{formatSettingsValue(activeModel || providerDraft.model)}</strong>
              <p className="muted">{effectiveModelSource}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">maxTokens</span>
              <strong>{formatSettingsValue(maxTokens || providerDraft.maxTokens)}</strong>
              <p className="muted">{effectiveMaxTokensSource}</p>
            </div>
            <div className="settings-source-card">
              <span className="tiny">Base URL</span>
              <strong>{formatSettingsValue(providerDraft.baseURL)}</strong>
              <p className="muted">{providerDraft.baseURL.trim() ? "直接来自 provider 条目" : "未填，依赖 provider/协议默认"}</p>
            </div>
          </div>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>待保存差异</h4><span className="tiny">{providerDiffItems.length + visibleRuntimeDiffItems.length} 项变更</span></div>
          {providerDiffItems.length + visibleRuntimeDiffItems.length > 0 ? (
            <div className="settings-diff-list">
              {visibleRuntimeDiffItems.map((item) => (
                <div key={`runtime-${item.label}`} className="settings-diff-item">
                  <span className="tiny">运行配置 · {item.label}</span>
                  <div className="settings-diff-values">
                    <span>{item.saved}</span>
                    <strong>→</strong>
                    <span>{item.current}</span>
                  </div>
                </div>
              ))}
              {providerDiffItems.map((item) => (
                <div key={`provider-${item.label}`} className="settings-diff-item">
                  <span className="tiny">Provider 条目 · {item.label}</span>
                  <div className="settings-diff-values">
                    <span>{item.saved}</span>
                    <strong>→</strong>
                    <span>{item.current}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">当前面板与已保存配置一致，没有待提交差异。</p>
          )}
        </div>

        <div className="detail-block settings-section-stack">
          <h4>快捷预设</h4>
          <div className="provider-preset-grid">
            {PROVIDER_PRESETS.map((preset) => (
              <button key={preset.key} className="tool-btn" type="button" onClick={() => applyPreset(preset)}>{preset.key === "openai" ? "OpenAI API" : preset.key === "codex-api" ? "Codex / OpenAI API" : preset.key === "deepseek" ? "DeepSeek" : preset.key === "openrouter" ? "OpenRouter" : preset.key === "anthropic" ? "Anthropic" : preset.key === "gemini" ? "Gemini" : preset.key === "ollama" ? "Ollama" : preset.key[0].toUpperCase() + preset.key.slice(1)}</button>
            ))}
          </div>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h4>导入 / 导出</h4><span className="tiny">JSON 片段，便于迁移 provider 配置</span></div>
          <div className="provider-action-row">
            <ToolBtn onClick={exportProviderJson}>导出当前 JSON</ToolBtn>
            <ToolBtn onClick={importProviderJson}>导入到当前面板</ToolBtn>
          </div>
          <textarea
            className="settings-textarea"
            value={providerJsonInput}
            onChange={(e) => setProviderJsonInput(e.target.value)}
            placeholder='{"activeProvider":"deepseek","runtime":{"model":"deepseek-chat"},"provider":{"baseURL":"https://api.deepseek.com/v1"}}'
          />
          <p className="muted">导出会带上当前 provider 草稿 + 运行层配置；导入后不会自动保存，需要你再点一次“保存”。</p>
        </div>
        </details>
        {saveState ? <p className="settings-save-state muted">{saveState}</p> : null}
      </aside>
    </div>
  );
}

export default function App() {
  const desktopBridge = getDesktopBridge();
  const hostMismatch = !desktopBridge;
  const { sessions, activeSessionId, detail, workspaceSnapshot, activeRunId, setActiveRunId, loading, sessionError, detailError, createSession, branchSession, renameSession, updateSessionStatus, deleteSession, selectSession, refreshSessions, refreshDetail } = useDesktopSessions();
  const [inputText, setInputText] = useState("");
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>(() => readSessionDrafts());
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<SettingsDrawerMode>("full");
  const [surface, setSurface] = useState<MainSurface>("home");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [decisionState, setDecisionState] = useState<Record<string, "approving" | "approved" | "denied">>({});
  const [runActionState, setRunActionState] = useState<"idle" | "cancelling" | "pausing" | "retrying">("idle");
  const [branchingRunId, setBranchingRunId] = useState<string | null>(null);
  const [quickModelSaving, setQuickModelSaving] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<DesktopAttachment[]>([]);
  const [composerHeight, setComposerHeight] = useState(188);
  const [composerDragging, setComposerDragging] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [sessionPaneWidth, setSessionPaneWidth] = useState(300);
  const [sessionPaneDragging, setSessionPaneDragging] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("新会话");
  const [newSessionError, setNewSessionError] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionView, setSessionView] = useState<"all" | "pinned" | "attention" | "active" | "archived">("all");
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => readPinnedSessions());
  const [sessionLifecycleOpen, setSessionLifecycleOpen] = useState(false);
  const [sessionLifecycleMode, setSessionLifecycleMode] = useState<"rename" | "archive" | "delete">("rename");
  const [sessionLifecycleValue, setSessionLifecycleValue] = useState("");
  const [sessionLifecycleBusy, setSessionLifecycleBusy] = useState(false);
  const [sessionLifecycleError, setSessionLifecycleError] = useState<string | null>(null);
  const { events, eventsError, streamState } = useRunEvents(activeRunId);
  const deferredEvents = useDeferredValue(events);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const detailRefreshClockRef = useRef(0);
  const detailRefreshTimerRef = useRef<number | null>(null);

  const activeRun = detail?.runs?.find((r) => r.id === activeRunId) ?? null;
  const sessionTurns = detail?.turns ?? [];
  const sessionConversation = detail?.conversation ?? [];
  const latestSessionRun = detail?.runs.length
    ? detail.runs.reduce((latest, run) => {
      const latestKey = latest.startedAt ?? latest.endedAt ?? latest.id;
      const runKey = run.startedAt ?? run.endedAt ?? run.id;
      return runKey > latestKey ? run : latest;
    })
    : null;
  const showActiveRunTranscript = Boolean(
    activeRun
      && (activeRun.status === "pending" || activeRun.status === "running" || activeRun.status === "paused" || activeRun.status === "needs_approval")
      && (sessionTurns.length === 0 || (latestSessionRun?.id ?? null) === (activeRunId ?? null)),
  );
  const pendingApprovals = workspaceSnapshot?.pendingApprovals ?? [];
  const artifacts = workspaceSnapshot?.artifacts ?? [];
  const sortedEvents = useMemo(() => [...deferredEvents].sort((a, b) => a.seq - b.seq), [deferredEvents]);
  const liveRunUsageSummary = useMemo(() => summarizeModelUsage(sortedEvents), [sortedEvents]);
  const sessionUsageSummary = useMemo(
    () => normalizeTokenUsage(detail?.tokenUsage ?? detail?.session.tokenUsage),
    [detail?.tokenUsage, detail?.session.tokenUsage],
  );
  const persistedActiveRunUsage = useMemo(
    () => normalizeTokenUsage(activeRun?.tokenUsage),
    [activeRun?.tokenUsage],
  );
  const usageSummary = useMemo(() => {
    const isLiveRun = activeRun?.status === "pending"
      || activeRun?.status === "running"
      || activeRun?.status === "paused"
      || activeRun?.status === "needs_approval";
    if (!isLiveRun || liveRunUsageSummary.requests === 0) return sessionUsageSummary;
    return addTokenUsage(sessionUsageSummary, subtractTokenUsage(liveRunUsageSummary, persistedActiveRunUsage));
  }, [activeRun?.status, liveRunUsageSummary, persistedActiveRunUsage, sessionUsageSummary]);
  const composerUsageSummary = liveRunUsageSummary.requests > 0 ? liveRunUsageSummary : usageSummary;
  const latestErrorEvent = [...sortedEvents].reverse().find((event) => event.kind === "error");
  const canShowCompactionBanner = activeRun?.status === "running" || activeRun?.status === "paused" || activeRun?.status === "needs_approval";
  const latestCompactionEvent = canShowCompactionBanner
    ? [...sortedEvents].reverse().find((event) => event.kind === "context_compacted" && isMeaningfulCompactionEvent(event))
    : undefined;
  const hasApprovedResume = Object.values(decisionState).includes("approved") && activeRun?.status === "running";
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const sessionLlm = detail?.session.llm ?? activeSession?.llm ?? null;
  const providerKey = sessionLlm?.provider || settings?.llm.provider || "deepseek";
  const currentProvider = settings?.providers[providerKey];
  const providerLabel = providerKey || "未设置";
  const modelLabel = sessionLlm?.model || settings?.llm.model || currentProvider?.model || "未设置";
  const quickModelOptions = useMemo(() => {
    if (!settings) return [];
    return buildComposerModelOptions(settings, providerKey, modelLabel);
  }, [modelLabel, providerKey, settings]);
  const composerModelSelectValue = composerModelValue(providerKey, modelLabel);
  const defaultWorkspaceLabel = settings?.workspaceRoot?.trim() || "未设置";
  const sessionWorkspaceLabel = detail?.session.workspaceRoot?.trim() || defaultWorkspaceLabel;
  const workspaceLabel = sessionWorkspaceLabel;
  const hasWorkspace = workspaceLabel !== "未设置";
  const sessionHasOwnWorkspace = Boolean(detail?.session.workspaceRoot?.trim())
    && !sameDisplayPath(detail?.session.workspaceRoot, defaultWorkspaceLabel);
  const workspaceModeLabel = sessionHasOwnWorkspace ? "当前会话目录" : "默认目录";
  const workspaceStatusDetail = isHiddenSessionWorkspace(workspaceLabel)
    ? `${workspaceLabel} · 旧版隐藏会话目录，重新打开后会自动纠正`
    : sessionHasOwnWorkspace
      ? `${workspaceLabel} · 本会话已单独切换`
      : workspaceLabel;
  const runtimeLabel = activeRun ? formatRunStatus(activeRun.status) : (activeSessionId ? "就绪" : "无会话");
  const streamLabel = formatStreamStateLabel(activeRunId ? streamState : "idle");
  const streamDetail = !activeRunId
    ? "先选择或启动一次运行，时间线才会开始流动。"
    : streamState === "connecting"
      ? "正在补齐历史时间线并接入实时流。"
      : streamState === "error"
        ? (eventsError ?? "时间线连接失败。")
        : `运行 ${activeRunId.slice(0, 8)} · ${sortedEvents.length} 条事件`;
  const approvalLabel = pendingApprovals.length > 0 ? `${pendingApprovals.length} 待处理` : "清空";
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aPinned = pinnedSessionIds.includes(a.id) ? 1 : 0;
      const bPinned = pinnedSessionIds.includes(b.id) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const priorityDiff = sessionPriority(b, activeSessionId) - sessionPriority(a, activeSessionId);
      if (priorityDiff !== 0) return priorityDiff;
      return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
    });
  }, [activeSessionId, pinnedSessionIds, sessions]);
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    return sortedSessions.filter((session) => {
      const matchesQuery = !query || session.title.toLowerCase().includes(query) || (session.summary ?? "").toLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (sessionView === "pinned") return pinnedSessionIds.includes(session.id);
      if (sessionView === "attention") return Boolean(session.attention?.hasPendingApproval || session.attention?.hasFailedRun || session.attention?.hasRunningRun);
      if (sessionView === "active") return session.status === "active";
      if (sessionView === "archived") return session.status === "archived";
      return true;
    });
  }, [pinnedSessionIds, sessionQuery, sessionView, sortedSessions]);
  const latestSession = sortedSessions[0] ?? null;
  const pinnedSessions = sortedSessions.filter((session) => pinnedSessionIds.includes(session.id));
  const focusSessions = sortedSessions.filter((session) => session.attention?.hasPendingApproval || session.attention?.hasFailedRun || session.attention?.hasRunningRun);
  const activeSessionDraft = activeSessionId ? (sessionDrafts[activeSessionId] ?? "") : "";
  const visibleArtifacts = useMemo(() => activeRunId ? artifacts.filter((artifact) => artifact.runId === activeRunId) : artifacts, [activeRunId, artifacts]);
  const sessionArtifacts = useMemo(
    () => [...artifacts].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [artifacts],
  );
  const artifactKindSummary = useMemo(() => {
    return Object.entries(sessionArtifacts.reduce<Record<string, number>>((acc, artifact) => {
      acc[artifact.kind] = (acc[artifact.kind] ?? 0) + 1;
      return acc;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [sessionArtifacts]);
  const runArtifactCounts = useMemo(() => artifacts.reduce<Record<string, number>>((acc, artifact) => {
    if (artifact.runId) {
      acc[artifact.runId] = (acc[artifact.runId] ?? 0) + 1;
    }
    return acc;
  }, {}), [artifacts]);
  const surfaceTitle = surface === "running"
    ? (detail?.session?.title ?? activeSession?.title ?? "会话")
    : "会话";
  const surfaceSubtitle = surface === "running"
    ? (activeRun ? `运行状态：${formatRunStatus(activeRun.status)}` : activeSession?.summary ?? "消息、审批和运行时间线都在这里。")
    : "左侧保留会话和设置，点开会话直接进入聊天。";
  const showChatView = surface === "running" && Boolean(activeSession);
  const eventKindCounts = useMemo(() => {
    return sortedEvents.reduce<Record<string, number>>((acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1;
      return acc;
    }, {});
  }, [sortedEvents]);
  const latestEvents = useMemo(() => sortedEvents.slice(-6).reverse(), [sortedEvents]);
  const latestToolCall = useMemo(() => [...sortedEvents].reverse().find((event) => event.kind === "tool_call") ?? null, [sortedEvents]);
  const latestAssistantMessage = useMemo(() => {
    return [...sortedEvents].reverse().find((event) => event.kind === "message" && (event.payload as Record<string, unknown> | undefined)?.role !== "user") ?? null;
  }, [sortedEvents]);
  const runActivity = useMemo(
    () => describeRunActivity(activeRun, sortedEvents, pendingApprovals),
    [activeRun, pendingApprovals, sortedEvents],
  );
  const failureInsight = useMemo(
    () => describeFailureInsight(activeRun, sortedEvents),
    [activeRun, sortedEvents],
  );
  const failureRepairPrompt = useMemo(() => failureInsight ? buildFailureRepairPrompt(failureInsight) : "", [failureInsight]);
  const runPhase = useMemo(
    () => describeRunPhase(activeRun, sortedEvents, pendingApprovals),
    [activeRun, pendingApprovals, sortedEvents],
  );
  const isProcessingRun = activeRun?.status === "pending" || activeRun?.status === "running";
  const isRunAwaitingApproval = activeRun?.status === "needs_approval";
  const composerHasPayload = Boolean(inputText.trim() || selectedAttachments.length > 0);
  const composerPlaceholder = isProcessingRun
    ? "运行中也可以补充指令；发送后会先暂停当前步骤，再带着补充继续..."
    : activeRun?.status === "paused"
      ? "输入“继续”或补充下一步，Agent 会接着上次现场干..."
      : "输入要继续推进的任务、问题或命令...";
  const composerSendLabel = runActionState === "pausing"
    ? "暂停中..."
    : sending && isProcessingRun
      ? "补充中..."
      : sending
        ? "..."
        : isProcessingRun
          ? (composerHasPayload ? "补充并继续 ↗" : "暂停")
          : activeRun?.status === "paused"
            ? "继续 ↗"
            : "发送 ↗";
  const canSubmitComposer = Boolean(
    activeSessionId
      && !isRunAwaitingApproval
      && !sending
      && runActionState === "idle"
      && (isProcessingRun || composerHasPayload || activeRun?.status === "paused"),
  );
  const canQuickSwitchModel = Boolean(
    settings
      && quickModelOptions.length > 0
      && !isProcessingRun
      && !sending
      && runActionState === "idle",
  );
  const canAttachFiles = Boolean(activeSessionId && !sending && !isProcessingRun && runActionState === "idle");
  const composerTone: SignalTone = isRunAwaitingApproval
    ? "warn"
    : streamState === "error"
      ? "danger"
      : isProcessingRun
        ? "success"
        : "neutral";
  const runProgressPercent = computeRunProgressPercent(activeRun, runPhase);
  const runProgressLabel = runActivity.label || runPhase.label;
  const runProgressDetail = runActivity.stalledDetail ?? runActivity.detail ?? runPhase.detail;
  const runActivityMeta = [runActivity.ageLabel ? `最近事件 ${runActivity.ageLabel}` : null, runActivity.stalled ? "长等待" : null]
    .filter(Boolean)
    .join(" · ");
  const composerBlockedReason = !activeSessionId
    ? "先创建或选中一个会话。"
    : runActionState !== "idle"
      ? (runActionState === "retrying" ? "正在重试运行…" : runActionState === "pausing" ? "正在暂停运行…" : "正在取消运行…")
      : sending
        ? "正在发送消息…"
        : isProcessingRun
          ? "运行中：可以补充一句新要求；不输入内容时，右下角会暂停当前 run。"
        : activeRun?.status === "needs_approval"
          ? "运行因审批暂停，请先处理上方审批卡片后继续。"
          : activeRun?.status === "paused"
            ? "已暂停：输入“继续”或补充下一步，Agent 会沿着上次现场继续。"
          : settingsError
            ? "先修好模型设置，再启动下一次运行。"
            : "Shift+Enter 换行 · Enter 发送";

  const handleQuickModelSwitch = async (option: ComposerModelOption) => {
    if (!settings || !activeSessionId || quickModelSaving || !canQuickSwitchModel) return;
    setQuickModelSaving(option.value);
    try {
      await requireDesktopBridge().updateSessionLlm({
        sessionId: activeSessionId,
        llm: buildSessionLlmSettings(
          option.provider,
          option.model,
          option.maxTokens ?? settings.providers[option.provider]?.maxTokens ?? settings.llm.maxTokens,
        ),
      });
      await refreshSessions();
      await refreshDetail();
      setSettingsError(null);
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(`切换当前会话模型失败：${message}`);
    } finally {
      setQuickModelSaving(null);
    }
  };

  useEffect(() => {
    if (!desktopBridge) {
      setSettingsError(getDesktopBridgeErrorMessage());
      return;
    }
    void desktopBridge.getSettings().then((value) => {
      setSettings(value);
      setSettingsError(null);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(`加载模型设置失败：${message}`);
    });
  }, [desktopBridge]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SESSION_PIN_STORAGE_KEY, JSON.stringify(pinnedSessionIds));
  }, [pinnedSessionIds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SESSION_DRAFT_STORAGE_KEY, JSON.stringify(sessionDrafts));
  }, [sessionDrafts]);

  useEffect(() => {
    setPinnedSessionIds((prev) => prev.filter((id) => sessions.some((session) => session.id === id)));
    setSessionDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => sessions.some((session) => session.id === id))));
  }, [sessions]);

  useEffect(() => {
    setInputText(activeSessionId ? (sessionDrafts[activeSessionId] ?? "") : "");
    setSelectedAttachments([]);
  }, [activeSessionId, sessionDrafts]);

  useEffect(() => {
    if (!activeSessionId) return;
    const refreshNow = () => {
      detailRefreshClockRef.current = Date.now();
      void refreshDetail();
      void refreshSessions();
    };
    const activeStatus = activeRun?.status;
    const isLiveRun = activeStatus === "pending" || activeStatus === "running";
    if (!isLiveRun) {
      refreshNow();
      return;
    }
    const elapsed = Date.now() - detailRefreshClockRef.current;
    if (elapsed >= RUN_REFRESH_MIN_INTERVAL_MS) {
      refreshNow();
      return;
    }
    if (detailRefreshTimerRef.current !== null) {
      window.clearTimeout(detailRefreshTimerRef.current);
    }
    detailRefreshTimerRef.current = window.setTimeout(() => {
      detailRefreshTimerRef.current = null;
      refreshNow();
    }, RUN_REFRESH_MIN_INTERVAL_MS - elapsed);
    return () => {
      if (detailRefreshTimerRef.current !== null) {
        window.clearTimeout(detailRefreshTimerRef.current);
        detailRefreshTimerRef.current = null;
      }
    };
  }, [activeSessionId, activeRun?.status, sortedEvents.length, refreshDetail, refreshSessions]);

  const handleApprovalDecision = async (approvalId: string, decision: "granted" | "denied") => {
    const approval = pendingApprovals.find((candidate) => candidate.id === approvalId);
    setDecisionState((prev) => ({ ...prev, [approvalId]: "approving" }));
    try {
      const bridge = requireDesktopBridge();
      await bridge.decideApproval({ approvalId, decision });
      setApprovalError(null);
      if (approval) {
        setActiveRunId(approval.runId);
        setSurface("running");
      }
      setDecisionState((prev) => ({
        ...prev,
        [approvalId]: decision === "granted" ? "approved" : "denied",
      }));
      await refreshDetail();
      await refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApprovalError(`${decision === "granted" ? "通过" : "拒绝"}审批动作失败：${message}`);
    } finally {
      setTimeout(() => {
        setDecisionState((prev) => {
          const next = { ...prev };
          delete next[approvalId];
          return next;
        });
      }, 1200);
    }
  };

  const submitMessage = async (message: string, attachments: DesktopAttachment[] = selectedAttachments) => {
    const sid = activeSessionId;
    const trimmedMessage = message.trim();
    const interruptedRun = isProcessingRun ? activeRun : null;
    const continuationRun = activeRun?.status === "paused" ? activeRun : null;
    const canUseDefaultContinuation = Boolean(continuationRun && attachments.length === 0);
    if (!sid || (!trimmedMessage && attachments.length === 0 && !canUseDefaultContinuation) || sending || isRunAwaitingApproval) return;
    setSending(true);
    try {
      const bridge = requireDesktopBridge();
      let outboundMessage = message;
      if (interruptedRun) {
        await bridge.pauseRun({ runId: interruptedRun.id });
        outboundMessage = [
          `补充指令：${trimmedMessage || "请结合当前输入继续任务。"}`,
          "",
          `请从刚刚暂停的运行继续，不要重做已经完成的工作。上一轮 run：${interruptedRun.id}。`,
          "先检查最近工具结果、审批结果和工作区当前状态，再继续推进；如果任务已经完成，请直接给出完成反馈。",
        ].join("\n");
      } else if (continuationRun) {
        outboundMessage = [
          trimmedMessage || "继续上次暂停的任务。",
          "",
          `请沿着已暂停的运行继续，不要从零开始。上一轮 run：${continuationRun.id}。`,
          "先检查最近工具结果、运行摘要、已有产物和工作区当前状态，再决定下一步；如果任务已经完成，请直接总结结果。",
        ].join("\n");
      }
      const run = await bridge.sendUserMessage({ sessionId: sid, message: outboundMessage, attachments });
      setActionError(null);
      setActiveRunId(run.id);
      setInputText("");
      setSelectedAttachments([]);
      setSessionDrafts((prev) => ({ ...prev, [sid]: "" }));
      void refreshDetail();
      void refreshSessions();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setActionError(`发送消息失败：${detail}`);
    } finally {
      setSending(false);
    }
  };

  const handlePauseRun = async () => {
    if (!activeRun || !isProcessingRun || runActionState !== "idle" || sending) return;
    setRunActionState("pausing");
    try {
      const bridge = requireDesktopBridge();
      const run = await bridge.pauseRun({ runId: activeRun.id });
      setActionError(null);
      setActiveRunId(run.id);
      await refreshDetail();
      await refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`暂停运行失败：${message}`);
    } finally {
      setRunActionState("idle");
    }
  };

  const handleSend = async () => {
    if (isProcessingRun && !inputText.trim() && selectedAttachments.length === 0) {
      await handlePauseRun();
      return;
    }
    await submitMessage(inputText, selectedAttachments);
  };


  const handleDraftRepairPrompt = () => {
    if (!activeSessionId || !failureInsight || !failureRepairPrompt) return;
    setSurface("running");
    setInputText(failureRepairPrompt);
    setSessionDrafts((prev) => ({ ...prev, [activeSessionId]: failureRepairPrompt }));
    setActionError(null);
    setTimeout(() => composerRef.current?.focus(), 0);
  };

  const handleSendRepairPrompt = async () => {
    if (!failureRepairPrompt || !activeSessionId || sending || runActionState !== "idle") return;
    await submitMessage(failureRepairPrompt, []);
  };

  const handleCancelRun = async () => {
    if (!activeRun || runActionState !== "idle") return;
    setRunActionState("cancelling");
    try {
      const bridge = requireDesktopBridge();
      const run = await bridge.cancelRun({ runId: activeRun.id });
      setActionError(null);
      setActiveRunId(run.id);
      await refreshDetail();
      await refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`取消运行失败：${message}`);
    } finally {
      setRunActionState("idle");
    }
  };

  const handleRetrySpecificRun = async (runId: string) => {
    if (runActionState !== "idle") return;
    setRunActionState("retrying");
    try {
      const run = await requireDesktopBridge().retryRun({ runId });
      setActionError(null);
      setActiveRunId(run.id);
      await refreshDetail();
      await refreshSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`重试运行失败：${message}`);
    } finally {
      setRunActionState("idle");
    }
  };

  const handleBranchSpecificRun = async (run: DesktopRun) => {
    if (branchingRunId || runActionState !== "idle") return;
    setBranchingRunId(run.id);
    try {
      const result = await branchSession(run.id);
      setActionError(null);
      setSurface("running");
      setActiveRunId(null);
      setSelectedAttachments([]);
      setInputText(result.suggestedPrompt);
      setSessionDrafts((prev) => ({ ...prev, [result.session.id]: result.suggestedPrompt }));
      setTimeout(() => composerRef.current?.focus(), 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`创建分支会话失败：${message}`);
    } finally {
      setBranchingRunId(null);
    }
  };

  const handleCopyRunPrompt = async (run: DesktopRun) => {
    const prompt = activeRun?.id === run.id && failureRepairPrompt
      ? failureRepairPrompt
      : buildRunQuickRepairPrompt(run, runArtifactCounts[run.id] ?? 0);
    try {
      await copyTextToClipboard(prompt);
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`复制运行提示失败：${message}`);
    }
  };

  const handleBranchFromRun = async () => {
    if (!activeRun) return;
    await handleBranchSpecificRun(activeRun);
  };

  const handleRetryRun = async () => {
    if (!activeRun) return;
    await handleRetrySpecificRun(activeRun.id);
  };

  const toggleSessionPin = (sessionId: string) => {
    setPinnedSessionIds((prev) => prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [sessionId, ...prev]);
  };

  const openSessionLifecycle = (mode: "rename" | "archive" | "delete") => {
    if (!activeSession) {
      setActionError("当前没有可操作的会话。");
      return;
    }
    setSessionLifecycleMode(mode);
    setSessionLifecycleValue(mode === "rename" ? activeSession.title : "");
    setSessionLifecycleError(null);
    setSessionLifecycleOpen(true);
  };

  const submitSessionLifecycle = async () => {
    if (!activeSession) return;
    setSessionLifecycleBusy(true);
    try {
      if (sessionLifecycleMode === "rename") {
        await renameSession(activeSession.id, sessionLifecycleValue.trim());
      } else if (sessionLifecycleMode === "archive") {
        await updateSessionStatus(activeSession.id, activeSession.status === "archived" ? "active" : "archived");
      } else {
        await deleteSession(activeSession.id);
        setPinnedSessionIds((prev) => prev.filter((id) => id !== activeSession.id));
        setSurface("home");
      }
      setActionError(null);
      setSessionLifecycleError(null);
      setSessionLifecycleOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionLifecycleError(message);
      setActionError(`会话操作失败：${message}`);
    } finally {
      setSessionLifecycleBusy(false);
    }
  };

  const handleCreateSession = () => {
    setNewSessionTitle("新会话");
    setNewSessionError(null);
    setNewSessionOpen(true);
  };

  const submitCreateSession = async () => {
    setCreatingSession(true);
    try {
      await createSession(newSessionTitle.trim() || undefined);
      setActionError(null);
      setNewSessionError(null);
      setNewSessionOpen(false);
      setSurface("running");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNewSessionError(message);
      setActionError(`创建会话失败：${message}`);
    } finally {
      setCreatingSession(false);
    }
  };

  const handleAutoAction = async () => {
    if (pendingApprovals.length > 0) {
      if (!activeSessionId) {
        const nextSessionId = focusSessions[0]?.id ?? sortedSessions[0]?.id ?? null;
        if (nextSessionId) {
          selectSession(nextSessionId);
        }
      }
      setSurface("running");
      return;
    }
    if (!activeSessionId) {
      try {
        await createSession("自动会话");
        setActionError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(`自动入口失败：${message}`);
        return;
      }
    }
    setSurface("running");
    if (!inputText.trim() && activeSessionId && (!activeRun || activeRun.status === "paused")) {
      const draft = activeRun?.status === "paused"
        ? "继续上次暂停的任务，从最近检查点往下推进，并先说明还差什么。"
        : "继续当前任务，先检查最近状态、可用产物和下一步。";
      setInputText(draft);
      setSessionDrafts((prev) => ({ ...prev, [activeSessionId]: draft }));
    }
    setTimeout(() => composerRef.current?.focus(), 0);
  };

  const handlePickAttachments = async () => {
    if (!activeSessionId || sending || isProcessingRun || runActionState !== "idle") return;
    try {
      const picked = await requireDesktopBridge().pickAttachments();
      if (picked.length === 0) return;
      setSelectedAttachments((prev) => {
        const map = new Map(prev.map((item) => [item.path, item]));
        for (const item of picked) map.set(item.path, item);
        return Array.from(map.values());
      });
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`选择附件失败：${message}`);
    }
  };

  const appendComposerFiles = (files: FileList | File[]): boolean => {
    const fileItems = Array.from(files);
    if (!fileItems.length) return false;
    if (!canAttachFiles) {
      setActionError("当前状态不能添加附件：请等发送/运行结束，或先暂停当前 run。");
      return false;
    }

    const attachments = fileItems
      .map(desktopAttachmentFromFile)
      .filter((item): item is DesktopAttachment => Boolean(item));

    if (!attachments.length) {
      setActionError("粘贴或拖拽的文件没有本地路径，请用“附件”按钮选择同一个文件。");
      return false;
    }

    setSelectedAttachments((prev) => {
      const map = new Map(prev.map((item) => [item.path, item]));
      for (const item of attachments) map.set(item.path, item);
      return Array.from(map.values());
    });
    setActionError(null);
    return true;
  };

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    if (appendComposerFiles(files)) event.preventDefault();
  };

  const handleComposerDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!canAttachFiles) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  };

  const handleComposerDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setComposerDragActive(false);
  };

  const handleComposerDrop = (event: React.DragEvent<HTMLElement>) => {
    setComposerDragActive(false);
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    appendComposerFiles(event.dataTransfer.files);
  };

  const handleComposerResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = composerHeight;
    setComposerDragging(true);

    const handleMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.min(420, Math.max(132, startHeight + startY - moveEvent.clientY));
      setComposerHeight(nextHeight);
    };

    const handleUp = () => {
      setComposerDragging(false);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  const handleSessionPaneResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sessionPaneWidth;
    setSessionPaneDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(420, Math.max(220, startWidth + moveEvent.clientX - startX));
      setSessionPaneWidth(nextWidth);
    };

    const handleUp = () => {
      setSessionPaneDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  const handleRemoveAttachment = (path: string) => {
    setSelectedAttachments((prev) => prev.filter((item) => item.path !== path));
  };

  const handleCopyArtifactUri = async (value: string | undefined) => {
    if (!value) return;
    try {
      await copyTextToClipboard(value);
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`复制产物地址失败：${message}`);
    }
  };

  const handleOpenArtifact = async (uri: string) => {
    try {
      await requireDesktopBridge().openArtifact({ uri });
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`打开本地产物失败：${message}`);
    }
  };

  const handleRevealArtifact = async (uri: string) => {
    try {
      await requireDesktopBridge().revealArtifact({ uri });
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`显示产物位置失败：${message}`);
    }
  };

  const handleCopyFailureField = async (value: string | undefined, label: string) => {
    if (!value) return;
    try {
      await copyTextToClipboard(value);
      setActionError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`复制${label}失败：${message}`);
    }
  };

  const openSettings = async (mode: SettingsDrawerMode = "full") => {
    setSettingsMode(mode);
    setSettingsOpen(true);
    try {
      setSettings(await requireDesktopBridge().getSettings());
      setSettingsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(`打开模型设置失败：${message}`);
    }
  };

  if (loading) {
    return <div className="shell"><p style={{ padding: 40, color: "#888" }}>{sessionError ?? "加载中..."}</p></div>;
  }

  if (hostMismatch) {
    return (
      <div className="shell">
        <div className="ambient" />
        <div className="grid" />
        <div className="noise" />
        <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)", minHeight: "100vh", alignItems: "center" }}>
          <section className="panel" style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: 16 }}>
            <div className="brand" style={{ paddingBottom: 0 }}>
              <div className="brand-badge">
                <div className="brand-mark">拾</div>
                <div>
                  <h1>拾光 Agent</h1>
                  <p>需要桌面宿主</p>
                </div>
              </div>
            </div>
            <GlobalBanner variant="warn" title="当前页面不能脱离桌面端单独运行" detail={getDesktopBridgeErrorMessage()} />
            <div className="detail-block" style={{ display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0 }}>正确打开方式</h3>
              <div className="detail-row"><span className="detail-key">开发启动</span><span className="detail-value">npm run desktop:dev</span></div>
              <div className="detail-row"><span className="detail-key">打包启动</span><span className="detail-value">启动打包后的 Electron 桌面应用</span></div>
              <p className="muted" style={{ margin: 0 }}>这个 renderer 依赖 Electron preload bridge `window.shiguang`。直接用 Chrome / Safari / Edge 打开 Vite 页面不会正常工作。</p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="ambient" />
      <div className="grid" />
      <div className="noise" />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={setSettings}
        mode={settingsMode}
        activeSessionId={activeSessionId}
        currentSessionWorkspaceRoot={detail?.session.workspaceRoot ?? null}
        currentSessionLlm={detail?.session.llm ?? activeSession?.llm ?? null}
        onSessionWorkspaceChanged={async () => {
          await refreshSessions();
          await refreshDetail();
        }}
        onSessionLlmChanged={async () => {
          await refreshSessions();
          await refreshDetail();
        }}
      />
      <NewSessionDialog
        open={newSessionOpen}
        value={newSessionTitle}
        saving={creatingSession}
        error={newSessionError}
        onChange={setNewSessionTitle}
        onClose={() => {
          if (creatingSession) return;
          setNewSessionOpen(false);
        }}
        onSubmit={() => { void submitCreateSession(); }}
      />
      <SessionLifecycleDialog
        open={sessionLifecycleOpen}
        mode={sessionLifecycleMode}
        session={activeSession}
        value={sessionLifecycleValue}
        saving={sessionLifecycleBusy}
        error={sessionLifecycleError}
        onChange={setSessionLifecycleValue}
        onClose={() => {
          if (sessionLifecycleBusy) return;
          setSessionLifecycleOpen(false);
        }}
        onSubmit={() => { void submitSessionLifecycle(); }}
      />

      {true ? (
        <div className="app simple-layout" style={{ "--session-pane-w": `${sessionPaneWidth}px` } as CSSProperties}>
          <aside className="panel app-nav-panel">
            <div className="app-nav-top">
              <div className="brand-mark">S</div>
            </div>

            <div className="app-nav-group">
              <button className={`app-nav-btn${surface === "home" ? " active" : ""}`} type="button" onClick={() => setSurface("home")} title="会话" aria-label="会话">
                <span className="app-nav-glyph">◌</span>
              </button>
              <button className={`app-nav-btn${showChatView ? " active" : ""}`} type="button" onClick={() => setSurface(activeSessionId ? "running" : "home")} title="聊天" aria-label="聊天">
                <span className="app-nav-glyph">⌁</span>
              </button>
              <button className="app-nav-btn" type="button" onClick={handleCreateSession} title="新建会话" aria-label="新建会话">
                <span className="app-nav-glyph">＋</span>
              </button>
            </div>

            <div className="app-nav-footer">
              <div className={`app-nav-status${pendingApprovals.length > 0 ? " warn" : ""}`}>
                <span>{pendingApprovals.length > 0 ? pendingApprovals.length : "•"}</span>
              </div>
              <button className="app-nav-btn secondary" type="button" onClick={() => { void openSettings(); }} title="设置" aria-label="设置">
                <span className="app-nav-glyph">⚙</span>
              </button>
            </div>
          </aside>

          <aside className="panel session-pane">
            <div className="session-pane-header">
              <div>
                <span className="tiny">My Workspace</span>
                <h2>拾光 Agent</h2>
                <p>{providerLabel} · {modelLabel}</p>
              </div>
              <div className="session-pane-header-actions">
                <IconBtn label="设置" onClick={openSettings}>⚙</IconBtn>
                <IconBtn label="新建会话" onClick={handleCreateSession}>＋</IconBtn>
              </div>
            </div>

            <div className="session-controls-card session-pane-tools">
              <input
                className="settings-input"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索会话标题 / 摘要"
              />
              <div className="session-filter-row">
                <button className={`session-filter-chip${sessionView === "all" ? " active" : ""}`} type="button" onClick={() => setSessionView("all")}>全部</button>
                <button className={`session-filter-chip${sessionView === "pinned" ? " active" : ""}`} type="button" onClick={() => setSessionView("pinned")}>固定</button>
                <button className={`session-filter-chip${sessionView === "attention" ? " active" : ""}`} type="button" onClick={() => setSessionView("attention")}>焦点</button>
                <button className={`session-filter-chip${sessionView === "active" ? " active" : ""}`} type="button" onClick={() => setSessionView("active")}>进行中</button>
                <button className={`session-filter-chip${sessionView === "archived" ? " active" : ""}`} type="button" onClick={() => setSessionView("archived")}>已归档</button>
              </div>
              {activeSession ? (
                <div className="session-action-row">
                  <ToolBtn onClick={() => openSessionLifecycle("rename")}>重命名</ToolBtn>
                  <ToolBtn onClick={() => openSessionLifecycle("archive")}>{activeSession.status === "archived" ? "恢复" : "归档"}</ToolBtn>
                  <ToolBtn onClick={() => openSessionLifecycle("delete")}>删除</ToolBtn>
                </div>
              ) : null}
            </div>

            <div className="session-tool-summary" title="Agent 当前工具能力，包含内置工具和用户自定义扩展">
              <div className="session-tool-summary-head">
                <span className="tiny">工具</span>
                <span>支持自扩展</span>
              </div>
              <div className="session-tool-chip-row">
                <span>文件</span>
                <span>终端</span>
                <span>Git</span>
                <span>网页搜索</span>
                <span>网页抓取</span>
                <span>GitHub</span>
                <span>MCP</span>
                <span>记忆</span>
                <span>Skill</span>
                <span>自定义工具</span>
              </div>
            </div>

            <div className="session-list session-pane-list">
              {sessions.length === 0 ? (
                <p className="muted" style={{ padding: 16 }}>还没有会话，点左上角新建一个。</p>
              ) : null}
              {sessions.length > 0 && filteredSessions.length === 0 ? (
                <p className="muted" style={{ padding: 16 }}>当前筛选下没有会话，换个关键词或视图试试。</p>
              ) : null}
              {filteredSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  active={session.id === activeSessionId}
                  pinned={pinnedSessionIds.includes(session.id)}
                  session={session}
                  onClick={() => {
                    selectSession(session.id);
                    setSurface("running");
                  }}
                  onTogglePin={() => toggleSessionPin(session.id)}
                />
              ))}
            </div>
          </aside>

          <div
            className={`layout-col-resize${sessionPaneDragging ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            title="拖动调整会话栏宽度"
            onMouseDown={handleSessionPaneResizeStart}
          />

          <main className="panel main chat-pane">
            <header className="chat-pane-header">
              <div className="chat-pane-title">
                <span className="tiny">{showChatView ? "当前会话" : "会话中心"}</span>
                <h2>{surfaceTitle}</h2>
                <p>{showChatView ? surfaceSubtitle : "保留会话、聊天和设置三件事，点开会话就能继续。"}</p>
              </div>
              <div className="toolbar">
                {showChatView && activeRun && (activeRun.status === "pending" || activeRun.status === "running" || activeRun.status === "needs_approval") ? (
                  <ToolBtn onClick={() => { void handleCancelRun(); }}>{runActionState === "cancelling" ? "取消中..." : "取消运行"}</ToolBtn>
                ) : null}
                {showChatView && activeRun ? (
                  <>
                    <ToolBtn onClick={() => { void handleRetryRun(); }}>{runActionState === "retrying" ? "重试中..." : "重新运行"}</ToolBtn>
                    <ToolBtn onClick={() => { void handleBranchFromRun(); }}>{branchingRunId === activeRun.id ? "分支中..." : "从此处分支"}</ToolBtn>
                  </>
                ) : null}
                {showChatView && activeSession ? (
                  <>
                    <ToolBtn onClick={() => openSessionLifecycle("rename")}>重命名</ToolBtn>
                    <ToolBtn onClick={() => openSessionLifecycle("archive")}>{activeSession.status === "archived" ? "恢复" : "归档"}</ToolBtn>
                  </>
                ) : null}
                <ToolBtn onClick={() => { void openSettings(); }}>设置</ToolBtn>
                <ToolBtn
                  primary
                  onClick={() => {
                    if (showChatView) {
                      void handleAutoAction();
                      return;
                    }
                    handleCreateSession();
                  }}
                >
                  {showChatView ? "继续工作" : "新建会话"}
                </ToolBtn>
              </div>
            </header>

            <section className="chat-banner-stack">
              {sessionError ? (
                <GlobalBanner variant="danger" title="会话连接异常" detail={sessionError} />
              ) : null}
              {detailError ? (
                <GlobalBanner variant="danger" title="会话详情异常" detail={detailError} />
              ) : null}
              {settingsError ? (
                <GlobalBanner variant="warn" title="模型设置不可用" detail={settingsError} />
              ) : null}
              {eventsError ? (
                <GlobalBanner variant="danger" title="运行时间线不可用" detail={eventsError} />
              ) : null}
              {approvalError ? (
                <GlobalBanner variant="warn" title="审批动作异常" detail={approvalError} />
              ) : null}
              {actionError ? (
                <GlobalBanner variant="danger" title="桌面动作失败" detail={actionError} />
              ) : null}
              {!showChatView && pendingApprovals.length > 0 ? (
                <GlobalBanner
                  variant="warn"
                  title={`待审批动作：${pendingApprovals.length}`}
                  detail="高风险动作正在等待审阅，打开当前会话即可直接处理。"
                />
              ) : null}
              {latestErrorEvent ? (
                <GlobalBanner
                  variant="danger"
                  title="运行错误"
                  detail={String(((latestErrorEvent.payload as Record<string, unknown> | undefined)?.message) ?? activeRun?.reason ?? "运行失败。")}
                />
              ) : null}
              {latestCompactionEvent ? (
                <GlobalBanner
                  variant="info"
                  title="上下文已压缩"
                  detail={String(((latestCompactionEvent.payload as Record<string, unknown> | undefined)?.message) ?? "为了适配模型预算，较早上下文已被压缩。")}
                />
              ) : null}
              {runActivity.stalled ? (
                <GlobalBanner
                  variant="warn"
                  title="运行长时间无新事件"
                  detail={runActivity.stalledDetail ?? "当前运行可能正在等待模型或长命令返回。"}
                />
              ) : null}
              {hasApprovedResume ? (
                <GlobalBanner
                  variant="success"
                  title="审批已通过，运行已恢复"
                  detail="阻塞动作已被通过，Agent 正从暂停点继续执行。"
                />
              ) : null}
              {showChatView && activeRun && activeRun.status !== "completed" && activeRun.status !== "cancelled" ? (
                <RunLiveReadout
                  run={activeRun}
                  phase={runPhase}
                  activity={runActivity}
                  progressPercent={runProgressPercent}
                />
              ) : null}
            </section>

            {!showChatView ? (
              <section className="chat-home">
                <div className="chat-empty compact">
                  <span className="tiny">会话页</span>
                  <h3>{sessions.length === 0 ? "从一个新会话开始" : "从左侧打开会话，直接进入聊天"}</h3>
                  <p className="muted">这里只保留会话入口。设置在左侧，选中会话后右边就是纯聊天界面。</p>
                  <div className="home-command-bar">
                    <button className="home-command-chip" type="button" onClick={handleCreateSession}>新建会话</button>
                    <button
                      className="home-command-chip"
                      type="button"
                      disabled={!latestSession}
                      onClick={() => {
                        if (!latestSession) return;
                        selectSession(latestSession.id);
                        setSurface("running");
                      }}
                    >
                      打开最近会话
                    </button>
                    <button className="home-command-chip" type="button" onClick={() => { void openSettings(); }}>打开设置</button>
                  </div>
                </div>
              </section>
            ) : (
              <>
                <section className="chat-surface">
                  <SimpleChatTranscript
                    key={activeSessionId ?? "no-session"}
                    entries={sessionConversation}
                    liveEvents={sortedEvents}
                    showLiveEvents={showActiveRunTranscript}
                    pendingApprovals={pendingApprovals}
                    decisionState={decisionState}
                    onApprovalDecision={handleApprovalDecision}
                  />
                </section>

                <div
                  className={`chat-composer-resize${composerDragging ? " dragging" : ""}`}
                  role="separator"
                  aria-orientation="horizontal"
                  title="拖动调整输入区高度"
                  onMouseDown={handleComposerResizeStart}
                />

                <section
                  className={`composer composer-dock${composerDragActive ? " dragging-over" : ""}`}
                  style={{ flexBasis: composerHeight }}
                  onDragOver={handleComposerDragOver}
                  onDragLeave={handleComposerDragLeave}
                  onDrop={handleComposerDrop}
                >
                  <div className="composer-hint-row">
                  <SignalPill tone={composerTone}>
                    {activeRun?.status === "needs_approval" ? "需要审批" : activeRun ? formatRunStatus(activeRun.status) : "就绪"}
                  </SignalPill>
                    <p className="muted">{failureInsight && activeRun?.status !== "running" ? `可直接写入修复提示：${failureInsight.nextStep}` : composerBlockedReason}</p>
                  </div>
                  <textarea
                    ref={composerRef}
                    value={inputText}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setInputText(nextValue);
                      if (activeSessionId) {
                        setSessionDrafts((prev) => ({ ...prev, [activeSessionId]: nextValue }));
                      }
                    }}
                  placeholder={composerPlaceholder}
                  disabled={!activeSessionId || sending || runActionState !== "idle"}
                    onPaste={handleComposerPaste}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
                  />
                  {selectedAttachments.length > 0 ? (
                    <div className="composer-attachment-row">
                      {selectedAttachments.map((attachment) => (
                        <div key={attachment.path} className="composer-attachment-chip">
                          <div>
                            <strong>{attachment.name}</strong>
                            <p className="muted">{formatAttachmentSize(attachment.size)}</p>
                          </div>
                          <button type="button" className="tool-btn" onClick={() => handleRemoveAttachment(attachment.path)}>移除</button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="composer-footer">
                    <div className="composer-actions">
                    <button className="composer-action" type="button" onClick={() => { void handlePickAttachments(); }} disabled={!activeSessionId || sending || isProcessingRun || runActionState !== "idle"}>📎 附件{selectedAttachments.length > 0 ? ` (${selectedAttachments.length})` : ""}</button>
                    <button className="composer-action" type="button" onClick={() => { void openSettings("model"); }}>⚙ 模型</button>
                  </div>
                  <div className="composer-right-actions">
                    <div className="composer-token-meter" title={liveRunUsageSummary.requests > 0 ? "当前 run 的实时模型用量" : "当前会话累计模型用量"}>
                      <span>{formatTokenCount(composerUsageSummary.totalTokens)}</span>
                      <small>tokens</small>
                    </div>
                    {quickModelOptions.length > 0 ? (
                      <div className="composer-model-switch" aria-label="当前会话模型切换">
                        <select
                          className="composer-model-select"
                          value={composerModelSelectValue}
                          title="只切换当前会话的模型"
                          disabled={!canQuickSwitchModel || quickModelSaving !== null}
                          onChange={(event) => {
                            const option = quickModelOptions.find((item) => item.value === event.target.value);
                            if (option) void handleQuickModelSwitch(option);
                          }}
                        >
                          {quickModelOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {quickModelSaving === option.value ? "切换中..." : option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="composer-current-model" title={`当前 provider：${providerLabel}`}>
                        <span>{providerLabel}</span>
                        <strong>{modelLabel}</strong>
                      </div>
                    )}
                    <button className={`send-btn ${isProcessingRun ? (composerHasPayload ? "supplement" : "pause") : ""}`} type="button" onClick={() => { void handleSend(); }} disabled={!canSubmitComposer}>
                      {composerSendLabel}
                    </button>
                  </div>
                  </div>
                </section>
              </>
            )}
          </main>
          <footer className="statusbar app-statusbar">
            <div className="stat-item">
              <span className="stat-icon">↑</span>
              <span className="stat-val">{formatTokenCount(usageSummary.inputTokens)}</span>
              <span className="stat-label">发送</span>
            </div>
            <div className="stat-item">
              <span className="stat-icon">↓</span>
              <span className="stat-val">{formatTokenCount(usageSummary.outputTokens)}</span>
              <span className="stat-label">接收</span>
            </div>
            <div className="statusbar-right">
              <div className="stat-item">
                <span className="stat-icon">▣</span>
                <span className="stat-val">{formatTokenCount(usageSummary.totalTokens)}</span>
                <span className="stat-label">Tokens 已用</span>
              </div>
              <div className="stat-item">
                <span className="stat-icon">◇</span>
                <span className="stat-val">{usageSummary.requests}</span>
                <span className="stat-label">模型请求</span>
              </div>
              <div className="stat-item" title={`当前会话目录：${workspaceLabel}`}>
                <span className="stat-icon">WS</span>
                <span className="stat-val">{compactPathTail(workspaceLabel)}</span>
                <span className="stat-label">{workspaceModeLabel}</span>
              </div>
              <div className="stat-item">
                <span className="stat-icon">↯</span>
                <span className="stat-val">{streamLabel}</span>
                <span className="stat-label">{providerLabel} · {modelLabel}</span>
              </div>
            </div>
          </footer>
        </div>
      ) : null}
      {/* <div className="app">
        <aside className="panel sidebar">
          <div className="brand">
            <div className="brand-badge">
              <div className="brand-mark">拾</div>
              <div>
                <h1>拾光 Agent</h1>
                <p>Desktop workspace · Craft flow</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <IconBtn label="设置" onClick={openSettings}>⚙</IconBtn>
              <IconBtn label="新建会话" onClick={handleCreateSession}>＋</IconBtn>
            </div>
          </div>

          <div className="detail-block" style={{ padding: 12 }}>
            <div className="section-title">
              <h3>当前模型</h3>
              <span className="tiny">桌面运行时</span>
            </div>
            <div className="meta-line" style={{ marginTop: 0 }}>
              <span>{providerLabel}</span>
              <span>{modelLabel}</span>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>{settings?.configPath ?? "尚未载入配置"}</p>
            <div className="meta-line">
              <SignalPill tone={settingsError ? "warn" : "accent"}>{settingsError ? "配置异常" : "已配置"}</SignalPill>
              <SignalPill tone={streamState === "error" ? "danger" : streamState === "live" ? "success" : "neutral"}>{streamLabel}</SignalPill>
            </div>
          </div>

          <div className="surface-nav">
            <SurfaceNavButton active={surface === "home"} label="Home" onClick={() => setSurface("home")} />
            <SurfaceNavButton active={surface === "running"} label="Workspace" count={activeRun ? "Live" : undefined} onClick={() => setSurface("running")} />
            <SurfaceNavButton active={surface === "approval"} label="Review" count={pendingApprovals.length > 0 ? String(pendingApprovals.length) : undefined} onClick={() => setSurface("approval")} />
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>
            <h3>会话</h3>
            <span className="tiny">{filteredSessions.length} / {sessions.length} · 固定 {pinnedSessions.length}</span>
          </div>

          <div className="session-controls-card">
            <input
              className="settings-input"
              value={sessionQuery}
              onChange={(event) => setSessionQuery(event.target.value)}
              placeholder="搜索会话标题 / 摘要"
            />
            <div className="session-filter-row">
              <button className={`session-filter-chip${sessionView === "all" ? " active" : ""}`} type="button" onClick={() => setSessionView("all")}>全部</button>
              <button className={`session-filter-chip${sessionView === "pinned" ? " active" : ""}`} type="button" onClick={() => setSessionView("pinned")}>固定</button>
              <button className={`session-filter-chip${sessionView === "attention" ? " active" : ""}`} type="button" onClick={() => setSessionView("attention")}>焦点</button>
              <button className={`session-filter-chip${sessionView === "active" ? " active" : ""}`} type="button" onClick={() => setSessionView("active")}>进行中</button>
              <button className={`session-filter-chip${sessionView === "archived" ? " active" : ""}`} type="button" onClick={() => setSessionView("archived")}>已归档</button>
            </div>
            <div className="session-action-row">
              <ToolBtn onClick={() => openSessionLifecycle("rename")}>重命名</ToolBtn>
              <ToolBtn onClick={() => openSessionLifecycle("archive")}>{activeSession?.status === "archived" ? "恢复" : "归档"}</ToolBtn>
              <ToolBtn onClick={() => openSessionLifecycle("delete")}>删除</ToolBtn>
            </div>
            <div className="session-quick-stats">
              <div className="session-quick-stat">
                <span className="tiny">恢复入口</span>
                <strong>{activeSessionId ? "当前会话" : latestSession?.title ?? "暂无"}</strong>
              </div>
              <div className="session-quick-stat">
                <span className="tiny">待关注</span>
                <strong>{focusSessions.length > 0 ? `${focusSessions.length} 个` : "清空"}</strong>
              </div>
            </div>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <p className="muted" style={{ padding: 16 }}>还没有会话，点 ＋ 新建一个。</p>
            )}
            {sessions.length > 0 && filteredSessions.length === 0 ? (
              <p className="muted" style={{ padding: 16 }}>当前筛选下没有会话，换个关键词或视图试试。</p>
            ) : null}
            {filteredSessions.map((s) => (
              <SessionCard
                key={s.id}
                active={s.id === activeSessionId}
                pinned={pinnedSessionIds.includes(s.id)}
                session={s}
                onClick={() => selectSession(s.id)}
                onTogglePin={() => toggleSessionPin(s.id)}
              />
            ))}
          </div>
        </aside>

        <main className="panel main">
          <header className="titlebar">
            <div className="title-group">
              <h2>{surfaceTitle}</h2>
              <p>{surfaceSubtitle}</p>
            </div>
            <div className="toolbar">
              {activeRun && (activeRun.status === "pending" || activeRun.status === "running" || activeRun.status === "needs_approval") ? (
                <ToolBtn onClick={() => { void handleCancelRun(); }}>{runActionState === "cancelling" ? "取消中..." : "取消运行"}</ToolBtn>
              ) : null}
              {activeRun ? (
                <>
                  <ToolBtn onClick={() => { void handleRetryRun(); }}>{runActionState === "retrying" ? "重试中..." : "重新运行"}</ToolBtn>
                  <ToolBtn onClick={() => { void handleBranchFromRun(); }}>{branchingRunId === activeRun.id ? "分支中..." : "从此处分支"}</ToolBtn>
                </>
              ) : null}
              <ToolBtn onClick={() => openSessionLifecycle("rename")}>重命名会话</ToolBtn>
              <ToolBtn onClick={() => openSessionLifecycle("archive")}>{activeSession?.status === "archived" ? "恢复会话" : "归档会话"}</ToolBtn>
              <ToolBtn onClick={openSettings}>模型设置</ToolBtn>
              <ToolBtn primary onClick={() => { void handleAutoAction(); }}>继续工作</ToolBtn>
            </div>
          </header>

          <section style={{ display: "grid", gap: 10, padding: "12px 18px 0" }}>
            {sessionError ? (
              <GlobalBanner variant="danger" title="会话连接异常" detail={sessionError} />
            ) : null}
            {detailError ? (
              <GlobalBanner variant="danger" title="会话详情异常" detail={detailError} />
            ) : null}
            {settingsError ? (
              <GlobalBanner variant="warn" title="模型设置不可用" detail={settingsError} />
            ) : null}
            {eventsError ? (
              <GlobalBanner variant="danger" title="运行时间线不可用" detail={eventsError} />
            ) : null}
            {approvalError ? (
              <GlobalBanner variant="warn" title="审批动作异常" detail={approvalError} />
            ) : null}
            {actionError ? (
              <GlobalBanner variant="danger" title="桌面动作失败" detail={actionError} />
            ) : null}
            {surface !== "running" && pendingApprovals.length > 0 ? (
              <GlobalBanner
                variant="warn"
                title={`待审批动作：${pendingApprovals.length}`}
                detail="高风险动作正在等待审阅，请在右侧面板通过或拒绝。"
              />
            ) : null}
            {latestErrorEvent ? (
              <GlobalBanner
                variant="danger"
                title="运行错误"
                detail={String(((latestErrorEvent.payload as Record<string, unknown> | undefined)?.message) ?? activeRun?.reason ?? "运行失败。")}
              />
            ) : null}
            {latestCompactionEvent ? (
              <GlobalBanner
                variant="info"
                title="上下文已压缩"
                detail={String(((latestCompactionEvent.payload as Record<string, unknown> | undefined)?.message) ?? "为了适配模型预算，较早上下文已被压缩。")}
              />
            ) : null}
            {runActivity.stalled ? (
              <GlobalBanner
                variant="warn"
                title="运行长时间无新事件"
                detail={runActivity.stalledDetail ?? "当前运行可能正在等待模型或长命令返回。"}
              />
            ) : null}
            {hasApprovedResume ? (
              <GlobalBanner
                variant="success"
                title="审批已通过，运行已恢复"
                detail="阻塞动作已被通过，Agent 正从暂停点继续执行。"
              />
            ) : null}
          </section>

          {surface === "home" ? (
            <>
              <section className="home-hero">
                <div className="section-title" style={{ marginBottom: 8 }}>
                  <h3>拾光 Agent Workspace</h3>
                  <SignalPill tone={pendingApprovals.length > 0 ? "warn" : "accent"}>{pendingApprovals.length > 0 ? `${pendingApprovals.length} 个待审批` : "工作台就绪"}</SignalPill>
                </div>
                <h1>把会话、运行、审批和产物收拢到一个 Craft 式桌面工作台。</h1>
                <p className="muted">主画布负责推进任务，左侧负责切换上下文，右侧持续暴露状态与产物，不再让样式和入口各说各话。</p>
                <div className="home-command-bar">
                  <button className="home-command-chip" type="button" onClick={() => setSurface("running")}>打开主画布</button>
                  <button className="home-command-chip" type="button" onClick={() => setSurface("approval")}>先处理审批</button>
                  <button className="home-command-chip" type="button" onClick={handleCreateSession}>新建会话</button>
                  <button className="home-command-chip" type="button" onClick={() => { void openSettings(); }}>模型设置</button>
                </div>
                <div className="launch-grid">
                  <LaunchCard title="继续上次任务" detail={latestSession ? `继续 ${latestSession.title}` : "打开最近会话并恢复上下文。"} meta={activeRun ? `当前运行：${formatRunStatus(activeRun.status)}` : "最近会话入口"} onClick={() => setSurface("running")} />
                  <LaunchCard title="处理待审批动作" detail={pendingApprovals.length > 0 ? `现在有 ${pendingApprovals.length} 个动作等待你确认。` : "当前没有待审批动作，审批面板保持可用。"} meta="进入审批面板" onClick={() => setSurface("approval")} />
                  <LaunchCard title="配置模型与来源" detail="直接打开设置，配置 DeepSeek / OpenRouter / Ollama 等 provider。" meta={providerLabel} onClick={() => { void openSettings(); }} />
                  <LaunchCard title="查看运行时间线" detail="把事件流、工具调用、审批和错误都拉到可见面板。" meta={`${sortedEvents.length} 个事件`} onClick={() => setSurface("running")} />
                </div>
              </section>

              <section className="status-grid">
                <StatusCard
                  label="运行态"
                  value={runtimeLabel}
                  tone={signalToneForRunStatus(activeRun?.status ?? null)}
                  detail={activeRun?.reason ?? (activeRun ? `开始于 ${activeRun.startedAt ? new Date(activeRun.startedAt).toLocaleTimeString() : "刚刚"}` : "桌面会话已准备好开始新运行。")}
                />
                <StatusCard
                  label="时间线"
                  value={streamLabel}
                  tone={streamState === "error" ? "danger" : streamState === "live" ? "success" : streamState === "connecting" ? "warn" : "neutral"}
                  detail={streamDetail}
                />
                <StatusCard
                  label="模型"
                  value={providerLabel}
                  tone={settingsError ? "warn" : currentProvider ? "accent" : "neutral"}
                  detail={`${modelLabel} · ${currentProvider?.baseURL ?? "请先在设置里配置 provider 注册表"}`}
                />
                <StatusCard
                  label={workspaceModeLabel}
                  value={hasWorkspace ? "就绪" : "缺失"}
                  tone={hasWorkspace ? "success" : "warn"}
                  detail={workspaceStatusDetail}
                />
                <StatusCard
                  label="审批"
                  value={approvalLabel}
                  tone={pendingApprovals.length > 0 ? "warn" : "success"}
                  detail={pendingApprovals.length > 0 ? "右侧有被阻塞的工具调用等待你处理。" : "当前没有高风险动作等待处理。"}
                />
                <StatusCard
                  label="事件"
                  value={String(sortedEvents.length)}
                  tone={sortedEvents.length > 0 ? "accent" : "neutral"}
                  detail={sortedEvents.length > 0 ? `最后事件时间 ${new Date(sortedEvents[sortedEvents.length - 1].createdAt).toLocaleTimeString()}` : "还没有采集到时间线事件。"}
                />
                <StatusCard
                  label="当前动作"
                  value={runActivity.label}
                  tone={runActivity.stalled ? "warn" : runActivity.tone}
                  detail={runActivity.stalledDetail ?? `${runActivity.detail}${runActivityMeta ? ` · ${runActivityMeta}` : ""}`}
                />
              </section>

              <section className="home-summary-grid">
                <div className="detail-block home-summary-block">
                  <div className="section-title"><h4>恢复会话</h4><span className="tiny">固定优先</span></div>
                  <div className="home-list">
                    {(pinnedSessions.length > 0 ? pinnedSessions : sortedSessions).slice(0, 3).map((session) => (
                      <button key={session.id} className="home-list-row" type="button" onClick={() => { selectSession(session.id); setSurface("running"); }}>
                        <div>
                          <strong>{session.title}</strong>
                          <p className="muted">{session.summary ?? "继续这个会话的上下文和运行状态。"}</p>
                        </div>
                        <span className="tiny">{pinnedSessionIds.includes(session.id) ? "已固定" : session.attention?.latestRunStatus ? formatRunStatus(session.attention.latestRunStatus) : formatSessionStatus(session.status)}</span>
                      </button>
                    ))}
                    {sortedSessions.length === 0 ? <p className="muted">还没有会话，先创建一个。</p> : null}
                  </div>
                </div>
                <div className="detail-block home-summary-block">
                  <div className="section-title"><h4>待处理焦点</h4><span className="tiny">下一步</span></div>
                  <div className="home-list">
                    <div className="home-list-row static"><strong>待审批动作</strong><span className="tiny">{pendingApprovals.length}</span></div>
                    <div className="home-list-row static"><strong>最新工具调用</strong><span className="tiny">{latestToolCall ? formatPayload((latestToolCall.payload as Record<string, unknown> | undefined)?.tool ?? latestToolCall.kind).slice(0, 18) : "暂无"}</span></div>
                    <div className="home-list-row static"><strong>最新助手输出</strong><span className="tiny">{latestAssistantMessage ? "已更新" : "暂无"}</span></div>
                  </div>
                </div>
                <div className="detail-block home-summary-block">
                  <div className="section-title"><h4>会话产物</h4><span className="tiny">{sessionArtifacts.length} 个</span></div>
                  {sessionArtifacts.length === 0 ? <p className="muted">当前会话还没有累计产物。完成运行后这里会直接出现可跳转入口。</p> : (
                    <div className="inspector-stack artifact-overview-stack">
                      {sessionArtifacts.slice(0, 2).map((artifact) => (
                        <ArtifactCard
                          key={artifact.id}
                          artifact={artifact}
                          compact
                          onSelectSession={(sessionId) => { selectSession(sessionId); setSurface("running"); }}
                          onSelectRun={(runId) => { setActiveRunId(runId); setSurface("running"); }}
                          onCopyUri={(uri) => { void handleCopyArtifactUri(uri); }}
                          onOpenLocal={(uri) => { void handleOpenArtifact(uri); }}
                          onRevealLocal={(uri) => { void handleRevealArtifact(uri); }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : null}

          {surface === "running" ? (
            <>
              <section className="workspace-canvas">
                <div className="workspace-context-bar">
                  <div className="workspace-context-copy">
                    <span className="tiny">当前工作流</span>
                    <h3>{detail?.session?.title ?? "未选择会话"}</h3>
                    <p className="muted">{activeRun?.reason ?? streamDetail}</p>
                  </div>
                  <div className="workspace-context-pills">
                    <SignalPill tone={signalToneForRunStatus(activeRun?.status ?? null)}>{runtimeLabel}</SignalPill>
                    <SignalPill tone={streamState === "error" ? "danger" : streamState === "live" ? "success" : streamState === "connecting" ? "warn" : "neutral"}>{streamLabel}</SignalPill>
                    <SignalPill tone={settingsError ? "warn" : currentProvider ? "accent" : "neutral"}>{providerLabel}</SignalPill>
                  </div>
                </div>

                <div className="run-phase-strip">
                  <div className={`codex-progress-readout ${activeRun?.status ?? "idle"}`}>
                    <div className="codex-progress-copy">
                      <span>{runProgressLabel}</span>
                      <span className="codex-progress-chevron">›</span>
                      <p className="muted">{runProgressDetail}</p>
                    </div>
                    <div className="codex-progress-track" aria-label="运行进度">
                      <span style={{ width: `${runProgressPercent}%` }} />
                    </div>
                  </div>
                  <div className="run-phase-head">
                    <div>
                      <span className="tiny">运行阶段</span>
                      <strong>{runPhase.label}</strong>
                    </div>
                    <p className="muted">{runPhase.detail}</p>
                  </div>
                  <div className="run-phase-steps">
                    {runPhase.steps.map((step) => (
                      <div key={step.key} className={`run-phase-step ${step.status}`}>
                        <span className="run-phase-dot" />
                        <div>
                          <strong>{step.label}</strong>
                          <p className="muted">{step.status === "done" ? "已完成" : step.status === "active" ? "进行中" : step.status === "warn" ? "等待处理" : "待进入"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="run-phase-meta-row">
                    {runPhase.elapsedLabel ? <SignalPill tone="accent">运行时长 {runPhase.elapsedLabel}</SignalPill> : null}
                    {runPhase.silenceLabel ? <SignalPill tone={runActivity.stalled ? "warn" : "neutral"}>静默 {runPhase.silenceLabel}</SignalPill> : null}
                    {runPhase.latestEventLabel ? <SignalPill tone="success">最新事件 {runPhase.latestEventLabel}</SignalPill> : null}
                  </div>
                </div>

                <div className="workspace-inline-stats">
                  <div className="workspace-inline-stat">
                    <span className="tiny">事件</span>
                    <strong>{sortedEvents.length}</strong>
                    <p className="muted">{sortedEvents.length > 0 ? `最后更新 ${new Date(sortedEvents[sortedEvents.length - 1].createdAt).toLocaleTimeString()}` : "还没有采集到时间线事件。"}</p>
                  </div>
                  <div className="workspace-inline-stat">
                    <span className="tiny">审批</span>
                    <strong>{approvalLabel}</strong>
                    <p className="muted">{pendingApprovals.length > 0 ? "先处理阻塞动作再继续。" : "当前没有阻塞动作。"}</p>
                  </div>
                  <div className="workspace-inline-stat">
                    <span className="tiny">{workspaceModeLabel}</span>
                    <strong>{hasWorkspace ? "就绪" : "缺失"}</strong>
                    <p className="muted">{workspaceStatusDetail}</p>
                  </div>
                  <div className="workspace-inline-stat">
                    <span className="tiny">当前动作</span>
                    <strong>{runActivity.label}</strong>
                    <p className="muted">{runActivity.stalledDetail ?? `${runActivity.detail}${runActivityMeta ? ` · ${runActivityMeta}` : ""}`}</p>
                  </div>
                  <div className="workspace-inline-stat">
                    <span className="tiny">运行阶段</span>
                    <strong>{runPhase.label}</strong>
                    <p className="muted">{runPhase.elapsedLabel ? `已运行 ${runPhase.elapsedLabel}` : runPhase.detail}</p>
                  </div>
                  <div className="workspace-inline-stat">
                    <span className="tiny">会话产物</span>
                    <strong>{sessionArtifacts.length}</strong>
                    <p className="muted">{artifactKindSummary.length > 0 ? artifactKindSummary.map(([kind, count]) => `${kind}×${count}`).join(" · ") : "当前还没有产物。"}</p>
                  </div>
                </div>

                <section className="detail-block workspace-artifact-overview">
                  <div className="section-title"><h4>会话产物总览</h4><span className="tiny">跨运行累计</span></div>
                  {sessionArtifacts.length === 0 ? <p className="muted">当前会话还没有累计产物。后续生成的摘要、文件链接或其他输出会先汇总在这里。</p> : (
                    <div className="inspector-stack artifact-overview-stack">
                      {sessionArtifacts.slice(0, 4).map((artifact) => (
                        <ArtifactCard
                          key={artifact.id}
                          artifact={artifact}
                          compact
                          onSelectSession={(sessionId) => { selectSession(sessionId); setSurface("running"); }}
                          onSelectRun={(runId) => { setActiveRunId(runId); setSurface("running"); }}
                          onCopyUri={(uri) => { void handleCopyArtifactUri(uri); }}
                          onOpenLocal={(uri) => { void handleOpenArtifact(uri); }}
                          onRevealLocal={(uri) => { void handleRevealArtifact(uri); }}
                        />
                      ))}
                    </div>
                  )}
                </section>

                <section className="chat-scroll workspace-timeline-pane">
                  <RunTimeline events={sortedEvents} streamState={streamState} />
                </section>
              </section>

              <section className="composer composer-dock">
                <div className="composer-hint-row">
                  <SignalPill tone={composerTone}>
                    {activeRun?.status === "needs_approval" ? "需要审批" : activeRun ? formatRunStatus(activeRun.status) : "就绪"}
                  </SignalPill>
                  <p className="muted">{failureInsight && activeRun?.status !== "running" ? `可直接写入修复提示：${failureInsight.nextStep}` : composerBlockedReason}</p>
                </div>
                <textarea
                  ref={composerRef}
                  value={inputText}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setInputText(nextValue);
                    if (activeSessionId) {
                      setSessionDrafts((prev) => ({ ...prev, [activeSessionId]: nextValue }));
                    }
                  }}
                  placeholder={composerPlaceholder}
                  disabled={!activeSessionId || sending || runActionState !== "idle"}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
                />
                {selectedAttachments.length > 0 ? (
                  <div className="composer-attachment-row">
                    {selectedAttachments.map((attachment) => (
                      <div key={attachment.path} className="composer-attachment-chip">
                        <div>
                          <strong>{attachment.name}</strong>
                          <p className="muted">{formatAttachmentSize(attachment.size)}</p>
                        </div>
                        <button type="button" className="tool-btn" onClick={() => handleRemoveAttachment(attachment.path)}>移除</button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="composer-footer">
                  <div className="composer-actions">
                    <button className="composer-action" type="button" onClick={() => { void handlePickAttachments(); }} disabled={!activeSessionId || sending || isProcessingRun || runActionState !== "idle"}>📎 附件{selectedAttachments.length > 0 ? ` (${selectedAttachments.length})` : ""}</button>
                    <button className="composer-action" type="button" onClick={() => { void openSettings("model"); }}>⚙ 模型</button>
                  </div>
                  <button className={`send-btn ${isProcessingRun ? (composerHasPayload ? "supplement" : "pause") : ""}`} type="button" onClick={() => { void handleSend(); }} disabled={!canSubmitComposer}>
                    {composerSendLabel}
                  </button>
                </div>
              </section>
            </>
          ) : null}

          {surface === "approval" ? (
            <>
              <section className="approval-main">
                <div className="section-title"><h3>待审批中心</h3><span className="tiny">{pendingApprovals.length} 个待处理</span></div>
                {pendingApprovals.length === 0 ? (
                  <div className="detail-block home-summary-block">
                    <p className="muted">当前没有待审批动作。后续涉及终端、写文件或发布等高风险动作时，会统一出现在这里。</p>
                  </div>
                ) : (
                  <div className="approval-main-list">
                    {pendingApprovals.map((approval) => (
                      <ApprovalReviewCard
                        key={approval.id}
                        approval={approval}
                        decisionState={decisionState[approval.id]}
                        onDecision={handleApprovalDecision}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="status-grid">
                <StatusCard
                  label="审批"
                  value={approvalLabel}
                  tone={pendingApprovals.length > 0 ? "warn" : "success"}
                  detail={pendingApprovals.length > 0 ? "从下方审批卡片审阅后恢复被阻塞的运行。" : "当前没有阻塞动作等待处理。"}
                />
                <StatusCard
                  label="当前运行"
                  value={activeRun ? formatRunStatus(activeRun.status) : "空闲"}
                  tone={signalToneForRunStatus(activeRun?.status ?? null)}
                  detail={activeRun?.reason ?? "选择一个会话来查看最近一次被阻塞的运行。"}
                />
                <StatusCard
                  label="会话"
                  value={detail?.session.title ?? "无"}
                  tone={detail?.session ? "accent" : "neutral"}
                  detail={detail ? `这个会话里共有 ${detail.runs.length} 次运行` : "当前没有选中会话。"}
                />
              </section>
            </>
          ) : null}
        </main>

        <aside className="panel detail">
          <div className="section-title">
            <h3>会话详情</h3>
            <span className="tiny">运行信息</span>
          </div>

          <div className="detail-scroll">
            <section className="detail-block inspector-block">
              <div className="section-title">
                <h4>运行检查器</h4>
                <SignalPill tone={signalToneForRunStatus(activeRun?.status ?? null)}>{activeRun ? formatRunStatus(activeRun.status) : "空闲"}</SignalPill>
              </div>
              <div className="inspector-grid">
                <div className="detail-row">
                  <span className="detail-key">运行 ID</span>
                  <span className="detail-value">{activeRun ? activeRun.id.slice(0, 10) : "—"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-key">开始时间</span>
                  <span className="detail-value">{activeRun?.startedAt ? new Date(activeRun.startedAt).toLocaleTimeString() : "—"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-key">事件数</span>
                  <span className="detail-value">{sortedEvents.length}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-key">时间线</span>
                  <span className="detail-value">{streamLabel}</span>
                </div>
              </div>
              {activeRun?.reason ? <p className="muted" style={{ marginTop: 10 }}>{activeRun.reason}</p> : null}
              {activeRun?.status === "needs_approval" ? (
                <p className="muted" style={{ marginTop: 10 }}>这次运行因策略审批被暂停，审阅下方待审批卡片后即可从中断点继续。</p>
              ) : null}
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>操作焦点</h4>
                <span className="tiny">实时快照</span>
              </div>
              <div className="inspector-stack">
                <div className="inspector-note">
                  <span className="detail-key">当前动作</span>
                  <p className="muted">{runActivity.detail}</p>
                  <div className="meta-line" style={{ marginTop: 8 }}>
                    <SignalPill tone={runActivity.stalled ? "warn" : runActivity.tone}>{runActivity.label}</SignalPill>
                    {runActivityMeta ? <span className="tiny">{runActivityMeta}</span> : null}
                  </div>
                  {runActivity.stalledDetail ? <p className="muted" style={{ marginTop: 8 }}>{runActivity.stalledDetail}</p> : null}
                </div>
                <div className="inspector-note">
                  <div className="section-title compact">
                    <h4>运行阶段</h4>
                    <SignalPill tone={runPhase.tone}>{runPhase.label}</SignalPill>
                  </div>
                  <p className="muted">{runPhase.detail}</p>
                  <div className="run-phase-steps compact">
                    {runPhase.steps.map((step) => (
                      <div key={step.key} className={`run-phase-step ${step.status}`}>
                        <span className="run-phase-dot" />
                        <div>
                          <strong>{step.label}</strong>
                          <p className="muted">{step.status === "done" ? "已完成" : step.status === "active" ? "进行中" : step.status === "warn" ? "等待处理" : "待进入"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="run-phase-meta-row">
                    {runPhase.elapsedLabel ? <SignalPill tone="accent">时长 {runPhase.elapsedLabel}</SignalPill> : null}
                    {runPhase.silenceLabel ? <SignalPill tone={runActivity.stalled ? "warn" : "neutral"}>静默 {runPhase.silenceLabel}</SignalPill> : null}
                    {runPhase.latestEventLabel ? <SignalPill tone="success">{runPhase.latestEventLabel}</SignalPill> : null}
                  </div>
                </div>
                {failureInsight ? (
                  <div className={`inspector-note failure-note ${failureInsight.tone}`}>
                    <div className="section-title compact">
                      <h4>{failureInsight.title}</h4>
                      <SignalPill tone={failureInsight.tone}>{failureInsight.failingCommand ?? "待修复"}</SignalPill>
                    </div>
                    <p className="muted"><strong>摘要：</strong>{failureInsight.summary}</p>
                    <p className="muted"><strong>原因：</strong>{failureInsight.cause}</p>
                    {failureInsight.lastAttempt ? <p className="muted"><strong>上次尝试：</strong>{failureInsight.lastAttempt}</p> : null}
                    <p className="muted"><strong>建议下一步：</strong>{failureInsight.nextStep}</p>
                    {failureInsight.evidence && failureInsight.evidence.length > 0 ? (
                      <div className="failure-chip-row">
                        {failureInsight.evidence.map((item) => (
                          <span className="failure-chip" key={item}>{item}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="failure-action-row">
                      {failureInsight.suspectFile ? (
                        <button className="tool-btn" type="button" onClick={() => { void handleCopyFailureField(failureInsight.suspectFile, "怀疑文件"); }}>复制怀疑文件</button>
                      ) : null}
                      {failureInsight.evidenceBlockContent ? (
                        <button className="tool-btn" type="button" onClick={() => { void handleCopyFailureField(failureInsight.evidenceBlockContent, "原始输出"); }}>复制原始输出</button>
                      ) : null}
                      <button className="tool-btn" type="button" disabled={!failureRepairPrompt || !activeSessionId} onClick={handleDraftRepairPrompt}>写入修复提示</button>
                      <button className="tool-btn" type="button" disabled={!failureRepairPrompt || !activeSessionId || sending || runActionState !== "idle"} onClick={() => { void handleSendRepairPrompt(); }}>{sending ? "发送中..." : "带修复提示继续"}</button>
                      <button className="tool-btn" type="button" disabled={!activeRun || branchingRunId === activeRun.id || runActionState !== "idle"} onClick={() => { void handleBranchFromRun(); }}>{branchingRunId === activeRun?.id ? "分支中..." : "分支继续修"}</button>
                      {activeRun?.status !== "running" ? (
                        <button className="tool-btn primary" type="button" disabled={runActionState !== "idle" || !activeRun} onClick={() => { void handleRetryRun(); }}>{runActionState === "retrying" ? "重试中..." : "重新运行"}</button>
                      ) : null}
                    </div>
                    {failureRepairPrompt ? <pre className="tool-json failure-repair-prompt">{failureRepairPrompt}</pre> : null}
                    {failureInsight.evidenceBlockContent ? (
                      <details className="failure-evidence-block">
                        <summary>{failureInsight.evidenceBlockTitle ?? "展开原始证据"}</summary>
                        <pre className="tool-json failure-evidence-pre">{failureInsight.evidenceBlockContent}</pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                <div className="inspector-note">
                  <span className="detail-key">最新助手输出</span>
                  <p className="muted">{latestAssistantMessage ? String(((latestAssistantMessage.payload as Record<string, unknown> | undefined)?.content) ?? "").slice(0, 180) || "助手已回复。" : "还没有助手输出。"}</p>
                </div>
                <div className="inspector-note">
                  <span className="detail-key">最新工具调用</span>
                  <p className="muted">{latestToolCall ? formatPayload((latestToolCall.payload as Record<string, unknown> | undefined)?.tool ?? (latestToolCall.payload as Record<string, unknown> | undefined)?.role ?? latestToolCall.kind).slice(0, 180) : "还没有工具调用。"}</p>
                </div>
              </div>
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>时间线拆解</h4>
                <span className="tiny">按事件类型</span>
              </div>
              <div className="inspector-grid">
                {Object.keys(eventKindCounts).length === 0 ? (
                  <p className="muted">还没有事件遥测。</p>
                ) : Object.entries(eventKindCounts).map(([kind, count]) => (
                  <div className="detail-row" key={kind}>
                    <span className="detail-key">{formatEventKindLabel(kind as DesktopEvent["kind"])}</span>
                    <span className="detail-value">{count}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>最近活动</h4>
                <span className="tiny">最近 6 条</span>
              </div>
              {latestEvents.length === 0 ? <p className="muted">还没有最近活动。</p> : (
                <div className="inspector-stack">
                  {latestEvents.map((event) => (
                    <div className="detail-row inspector-event-row" key={event.id}>
                      <div>
                        <div className="meta-line" style={{ marginBottom: 4 }}>
                          <SignalPill tone={eventTone(event.kind)}>{formatEventKindLabel(event.kind)}</SignalPill>
                          <span className="tiny">{formatAgeFromTimestamp(event.createdAt) ?? new Date(event.createdAt).toLocaleTimeString()}</span>
                        </div>
                        <p className="muted">{String(((event.payload as Record<string, unknown> | undefined)?.message) ?? ((event.payload as Record<string, unknown> | undefined)?.content) ?? formatPayload(event.payload)).slice(0, 120) || "暂无细节"}</p>
                      </div>
                      <span className="detail-value">{new Date(event.createdAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>运行列表</h4>
                <span className="tiny">{detail?.runs.length ?? 0}</span>
              </div>
              {!detail || detail.runs.length === 0 ? <p className="muted">还没有运行记录。</p> : (
                <div className="inspector-stack">
                  {detail.runs.map((r) => (
                    <DetailRunRow
                      key={r.id}
                      run={r}
                      active={r.id === activeRunId}
                      artifactCount={runArtifactCounts[r.id] ?? 0}
                      retryBusy={runActionState === "retrying"}
                      branchBusy={branchingRunId === r.id}
                      onClick={() => setActiveRunId(r.id)}
                      onShowArtifacts={() => setActiveRunId(r.id)}
                      onCopyPrompt={() => { void handleCopyRunPrompt(r); }}
                      onBranch={() => { void handleBranchSpecificRun(r); }}
                      onRetry={() => { void handleRetrySpecificRun(r.id); }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>待审批</h4>
                <span className="tiny">{pendingApprovals.length}</span>
              </div>
              {pendingApprovals.length === 0 ? <p className="muted">当前没有待审批动作。</p> : (
                <div className="inspector-stack">
                  {pendingApprovals.map((approval) => (
                    <ApprovalReviewCard
                      key={approval.id}
                      approval={approval}
                      decisionState={decisionState[approval.id]}
                      onDecision={handleApprovalDecision}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>运行产物</h4>
                <span className="tiny">{visibleArtifacts.length}</span>
              </div>
              {visibleArtifacts.length === 0 ? <p className="muted">当前会话还没有可见产物。完成一次运行后，摘要会直接出现在这里。</p> : (
                <div className="inspector-stack">
                  {visibleArtifacts.slice(0, 6).map((artifact) => (
                    <ArtifactCard
                      key={artifact.id}
                      artifact={artifact}
                      onSelectSession={(sessionId) => { selectSession(sessionId); setSurface("running"); }}
                      onSelectRun={(runId) => { setActiveRunId(runId); setSurface("running"); }}
                      onCopyUri={(uri) => { void handleCopyArtifactUri(uri); }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="detail-block">
              <div className="section-title">
                <h4>已配置 Provider</h4>
                <span className="tiny">{settings ? Object.keys(settings.providers).length : 0}</span>
              </div>
              {settings && Object.keys(settings.providers).length > 0 ? Object.entries(settings.providers).map(([key, provider]) => (
                <div className="detail-row" key={key}>
                  <span className="detail-key">{key}</span>
                  <span className="detail-value">{provider.model ?? provider.apiKeyEnv ?? provider.authMode ?? "已配置"}</span>
                </div>
              )) : <p className="muted">去模型设置里添加 DeepSeek / Codex / OpenRouter / Ollama。</p>}
            </section>
          </div>
        </aside>
      </div>
      */}
    </div>
  );
}

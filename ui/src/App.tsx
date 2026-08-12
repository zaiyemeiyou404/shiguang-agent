import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktopSessions, useRunEvents } from "./hooks/useDesktopSessions";
import { getDesktopBridge, getDesktopBridgeErrorMessage, requireDesktopBridge } from "./bridge";
import type { DesktopSession, DesktopRun, DesktopConversationEntry, DesktopEvent, DesktopSettings, DesktopApproval, DesktopArtifact, DesktopProviderConnectionResult, DesktopAttachment, ToolApprovalMode } from "./bridge";

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

const PROVIDER_PRESETS: ProviderDraft[] = [
  { key: "deepseek", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.deepseek.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat", maxTokens: "4096" },
  { key: "openai", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "codex-api", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" },
  { key: "openrouter", type: "openai-compatible", authMode: "api_key", baseURL: "https://openrouter.ai/api/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-5", maxTokens: "4096" },
  { key: "anthropic", type: "anthropic", authMode: "api_key", baseURL: "https://api.anthropic.com/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-3-5-sonnet-latest", maxTokens: "4096" },
  { key: "gemini", type: "gemini", authMode: "api_key", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", maxTokens: "4096" },
  { key: "ollama", type: "openai-compatible", authMode: "none", baseURL: "http://127.0.0.1:11434/v1", apiKey: "", apiKeyMasked: "", hasStoredApiKey: false, apiKeyEnv: "", model: "qwen2.5-coder:14b", maxTokens: "4096" },
];

function findProviderPreset(key: string): ProviderDraft | null {
  return PROVIDER_PRESETS.find((preset) => preset.key === key) ?? null;
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
    error: "错误",
    system: "系统",
    approval_request: "请求审批",
    approval_granted: "审批通过",
    approval_denied: "审批拒绝",
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

function eventTone(kind: DesktopEvent["kind"]): SignalTone {
  if (kind === "error") return "danger";
  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") return "warn";
  if (kind === "tool_result") return "success";
  if (kind === "tool_call" || kind === "context_compacted") return "accent";
  return "neutral";
}

function eventLane(kind: DesktopEvent["kind"]): string {
  if (kind === "message") return "conversation";
  if (kind === "tool_call" || kind === "tool_result") return "tools";
  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") return "approvals";
  if (kind === "error") return "errors";
  if (kind === "context_compacted") return "context";
  return "system";
}

type TimelineLane = ReturnType<typeof eventLane>;

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
  const preview = session.summary ?? "打开后继续这个会话。";
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
      <p className="session-preview">{preview}</p>
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
      host.scrollTo({ top: host.scrollHeight });
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
          <p className="message-text">{item.content}</p>
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
  type ChatTranscriptItem = {
    id: string;
    source: "turn" | "event";
    kind?: DesktopConversationEntry["kind"] | DesktopEvent["kind"];
    role?: "user" | "system";
    from: string;
    time: string;
    createdAt?: string;
    content: string;
    payload?: unknown;
    duplicateCount?: number;
  };

  const historyItems: ChatTranscriptItem[] = entries.flatMap((entry): ChatTranscriptItem[] => {
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
    }];
  });

  const persistedEventIds = new Set(
    historyItems
      .filter((item) => item.source === "event")
      .map((item) => item.id),
  );

  const liveItems: ChatTranscriptItem[] = !showLiveEvents ? [] : liveEvents.flatMap((event): ChatTranscriptItem[] => {
    const payload = eventPayloadRecord(event);
    if (event.kind === "context_compacted") return [];
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
        content,
      }];
    }

    if (event.kind === "error") {
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
      }];
    }

    if (event.kind === "system" || event.kind === "approval_request" || event.kind === "approval_granted" || event.kind === "approval_denied") {
      const title = event.kind === "approval_granted"
        ? "审批已通过"
        : event.kind === "approval_denied"
          ? "审批已拒绝"
          : event.kind === "approval_request"
            ? "请求审批"
            : "系统消息";
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
      }];
    }

    return [];
  });

  const items = [...historyItems, ...liveItems].reduce<ChatTranscriptItem[]>((acc, item) => {
    const prev = acc[acc.length - 1];
    const canCollapse = prev
      && item.role !== "user"
      && item.kind !== "approval_request"
      && prev.kind !== "approval_request"
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
      host.scrollTo({ top: host.scrollHeight });
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
      {items.map((item) => {
        if (item.kind === "approval_request") {
          const payload = item.payload && typeof item.payload === "object" ? item.payload as { approvalId?: unknown } : {};
          const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
          const approval = approvalId ? pendingApprovals.find((candidate) => candidate.id === approvalId) : undefined;
          if (approval) {
            return (
              <Message
                key={item.id}
                role="system"
                from="审批"
                time={item.duplicateCount && item.duplicateCount > 1 ? `${item.time} x${item.duplicateCount}` : item.time}
              >
                <ApprovalReviewCard
                  approval={approval}
                  decisionState={decisionState[approval.id]}
                  onDecision={onApprovalDecision}
                />
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
            <p className="message-text">{item.content}</p>
          </Message>
        );
      })}
    </div>
  );
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

function eventPayloadRecord(event: DesktopEvent): Record<string, unknown> {
  return (typeof event.payload === "object" && event.payload !== null)
    ? event.payload as Record<string, unknown>
    : {};
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
  if (cwd && cwd !== rows[2]?.value) rows.push({ label: "工作目录", value: cwd });
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
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  return `${days}d 前`;
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
  if (run.reason) {
    lines.push(`原因：${truncateInline(run.reason, 240)}`);
  }
  if (artifactCount > 0) {
    lines.push(`这个运行已有 ${artifactCount} 个产物，先看产物再继续。`);
  }
  lines.push("先检查这次运行的结果、报错和产物，再决定下一步；如果需要修复，做最小改动并重新验证。");
  return lines.join("\n");
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
  const latestAssistantMessage = [...events].reverse().find((event) => event.kind === "message" && eventPayloadRecord(event).role !== "user") ?? null;
  const latestErrorEvent = [...events].reverse().find((event) => event.kind === "error") ?? null;
  const pendingApproval = pendingApprovals.find((approval) => approval.runId === run.id) ?? null;
  const latestPendingToolCall = findLatestToolCallWithoutResult(events);
  const latestToolResult = [...events].reverse().find((event) => event.kind === "tool_result") ?? null;
  const latestToolResultPayload = latestToolResult ? eventPayloadRecord(latestToolResult) : null;

  let label = formatRunStatus(run.status);
  let detail = run.reason ?? "等待新的运行事件。";
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
    detail = run.reason ?? "本轮到达步骤预算，已保留现场。点击继续工作后会沿着最近的检查点继续推进。";
    tone = "warn";
  } else if (latestErrorEvent) {
    const payload = eventPayloadRecord(latestErrorEvent);
    label = run.status === "failed" ? "运行失败" : "最新错误";
    detail = typeof payload.message === "string"
      ? payload.message
      : (run.reason ?? "时间线记录了一次错误事件。") ;
    tone = "danger";
  } else if (latestPendingToolCall) {
    const payload = eventPayloadRecord(latestPendingToolCall);
    const toolName = toolEventName(latestPendingToolCall) ?? "工具";
    label = `执行 ${toolName}`;
    detail = payload.input !== undefined
      ? summarizeToolBlockValue(payload.input)
      : "工具已发出，正在等待结果。";
    tone = "accent";
  } else if (latestToolResult) {
    const toolName = toolEventName(latestToolResult) ?? "工具";
    label = `${toolName} 完成`;
    detail = latestToolResultPayload?.output !== undefined
      ? summarizeToolBlockValue(latestToolResultPayload.output)
      : "工具结果已返回。";
    tone = "success";
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
  const latestAssistantMessage = [...events].reverse().find((event) => event.kind === "message" && eventPayloadRecord(event).role !== "user") ?? null;
  const latestPendingToolCall = findLatestToolCallWithoutResult(events);
  const latestToolResult = findLatestToolResult(events);
  const latestErrorEvent = [...events].reverse().find((event) => event.kind === "error") ?? null;
  const pendingApproval = pendingApprovals.find((approval) => approval.runId === run.id) ?? null;

  let currentStep: RunPhaseStep["key"] = run.status === "pending" ? "boot" : "plan";
  let label = "规划中";
  let detail = run.reason ?? "正在整理当前任务并决定下一步。";
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
    detail = run.reason ?? "本轮到达步骤预算，已保留现场。继续工作会沿最近的检查点往下推进。";
    tone = "warn";
  } else if (latestErrorEvent || run.status === "failed") {
    currentStep = latestPendingToolCall || latestToolResult ? "tool" : "reply";
    label = "运行受阻";
    detail = run.reason ?? "最近一次运行在处理中遇到错误。";
    tone = "danger";
  } else if (latestPendingToolCall || latestToolResult) {
    currentStep = "tool";
    label = latestPendingToolCall ? "工具执行中" : "工具已返回";
    detail = latestPendingToolCall
      ? `正在等待 ${toolEventName(latestPendingToolCall) ?? "工具"} 返回结果。`
      : `${toolEventName(latestToolResult!) ?? "工具"} 已返回，准备继续推进。`;
    tone = latestPendingToolCall ? "accent" : "success";
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

  if (kind === "tool_call") {
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
            <pre className="tool-json">{formatPayload(p?.input ?? "")}</pre>
          </div>
        </div>
      </article>
    );
  }

  if (kind === "tool_result") {
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

  const timelineItems: Array<
    | { type: "event"; event: DesktopEvent }
    | { type: "tool_block"; id: string; callEvent: DesktopEvent; resultEvent?: DesktopEvent; pairingMode: "call_id" | "fallback" | "pending" }
  > = [];

  const matchedResultIds = new Set<string>();

  for (let index = 0; index < filteredEvents.length; index += 1) {
    const event = filteredEvents[index];
    if (event.kind === "tool_call") {
      const callToolName = toolEventName(event);
      const callToolCallId = toolEventCallId(event);
      let matchedResultIndex = -1;
      let pairingMode: "call_id" | "fallback" | "pending" = "pending";

      for (let lookahead = index + 1; lookahead < filteredEvents.length; lookahead += 1) {
        const candidate = filteredEvents[lookahead];
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
        const resultEvent = filteredEvents[matchedResultIndex];
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
  }, [activeFilter, autoFollow, timelineItems.length]);

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
      ) : timelineItems.map((item) => {
        const isLatestItem = item.type === "tool_block"
          ? item.callEvent.id === latestVisibleItemId || item.resultEvent?.id === latestVisibleItemId
          : item.event.id === latestVisibleItemId;

        if (item.type === "tool_block") {
          const { callEvent, resultEvent, id, pairingMode } = item;
          const callPayload = (callEvent.payload as Record<string, unknown> | undefined) ?? {};
          const resultPayload = (resultEvent?.payload as Record<string, unknown> | undefined) ?? {};
          const toolLabel = String(callPayload.tool ?? callPayload.role ?? "tool");
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
                      <p className="muted">{resultEvent ? "工具调用和结果已合并成一个执行块。" : "工具调用还在等待结果返回。"}</p>
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
                      <span className="detail-value">{summarizeToolBlockValue(callPayload.input)}</span>
                    </div>
                    <div className="tool-block-chip">
                      <span className="tiny">结果</span>
                      <span className="detail-value">{resultEvent ? summarizeToolBlockValue(resultPayload.output) : "等待中"}</span>
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

function ApprovalReviewCard({
  approval,
  decisionState,
  onDecision,
}: {
  approval: DesktopApproval;
  decisionState?: "approving" | "approved" | "denied";
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

function SettingsDrawer({
  open,
  onClose,
  settings,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  settings: DesktopSettings | null;
  onSaved: (settings: DesktopSettings) => void;
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

  useEffect(() => {
    if (!settings || !open) return;
    const catalog = providerCatalogFromSettings(settings);
    const providerKeys = Object.keys(catalog);
    const providerKey = catalog[settings.llm.provider] ? settings.llm.provider : (providerKeys[0] ?? "openai");
    setWorkspaceRoot(settings.workspaceRoot ?? "");
    setActiveProvider(providerKey);
    setActiveModel(settings.llm.model ?? catalog[providerKey]?.model ?? "");
    setMaxTokens(settings.llm.maxTokens
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
  }, [settings, open]);

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
      const mcpServers = parseMcpServersJson(mcpServersJson);
      const next = {
        ...buildSettings(settings, providerCatalog, workspaceRoot, activeProvider, activeModel, maxTokens, toolApprovalMode),
        mcpServers,
      };
      const saved = await requireDesktopBridge().saveSettings(next);
      onSaved(saved);
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

  const connectionTone = connectionResult ? (connectionResult.ok ? "success" : "danger") : providerTone(providerDraft);
  const connectionLabel = connectionResult ? (connectionResult.ok ? "已连通" : "失败") : providerLabel(providerDraft);
  const authSummary = providerDraft.authMode === "none"
    ? "当前 provider 不要求 API Key。"
    : providerDraft.apiKey.trim()
      ? "优先使用当前面板里填写的新 API Key。"
      : providerDraft.hasStoredApiKey
        ? `当前已保存 API Key：${providerDraft.apiKeyMasked || "已保存"}。留空即继续使用它。`
        : providerDraft.apiKeyEnv.trim()
          ? `将读取环境变量 ${providerDraft.apiKeyEnv.trim()}。`
          : "还没有可用的 API Key 来源。";
  const selectedSavedDraft = settings.providers[activeProvider]
    ? providerDraftFromSettings(settings, activeProvider)
    : createProviderDraft(activeProvider);
  const providerDirty = JSON.stringify(normalizeProviderDraftForCompare(providerDraft)) !== JSON.stringify(normalizeProviderDraftForCompare(selectedSavedDraft));
  const runtimeDirty = workspaceRoot.trim() !== (settings.workspaceRoot ?? "")
    || activeProvider !== (settings.llm.provider ?? "openai")
    || activeModel.trim() !== (settings.llm.model ?? "")
    || maxTokens.trim() !== (settings.llm.maxTokens ? String(settings.llm.maxTokens) : "")
    || toolApprovalMode !== (settings.toolApprovalMode ?? "ask")
    || mcpServersJson.trim() !== formatMcpServersJson(settings.mcpServers).trim();
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
    { label: "工作目录", current: formatSettingsValue(workspaceRoot), saved: formatSettingsValue(settings.workspaceRoot) },
    { label: "当前 Provider", current: activeProvider, saved: settings.llm.provider ?? "openai" },
    { label: "运行模型", current: formatSettingsValue(activeModel), saved: formatSettingsValue(settings.llm.model) },
    { label: "运行 maxTokens", current: formatSettingsValue(maxTokens), saved: formatSettingsValue(settings.llm.maxTokens ? String(settings.llm.maxTokens) : "") },
    { label: "工具审批", current: toolApprovalModeLabel(toolApprovalMode), saved: toolApprovalModeLabel(settings.toolApprovalMode ?? "ask") },
  ].filter((item) => item.current !== item.saved);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
      <aside className="panel settings-drawer">
        <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
          <div className="title-group">
            <h2>模型与 Provider 设置</h2>
            <p>Hermes / Craft 风格：当前模型 + provider 注册表</p>
          </div>
          <div className="toolbar">
            <ToolBtn onClick={onClose}>关闭</ToolBtn>
            <ToolBtn onClick={() => { void testConnection(); }}>{testingConnection ? "测试中..." : "测试连接"}</ToolBtn>
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

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>当前配置</h3><span className="tiny">{settings.configPath}</span></div>
          <div className="settings-inline-grid">
            <div>
              <label className="tiny">工作目录</label>
              <input className="settings-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
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
              <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-chat / gpt-5 / openai/gpt-5" />
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
          <div>
            <label className="tiny">MCP Servers JSON</label>
            <textarea
              className="settings-input"
              value={mcpServersJson}
              onChange={(e) => setMcpServersJson(e.target.value)}
              rows={9}
              spellCheck={false}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", resize: "vertical" }}
              placeholder={'{\n  "filesystem": {\n    "transport": "stdio",\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "G:/projects"]\n  }\n}'}
            />
            <p className="muted" style={{ margin: 0 }}>
              配置 stdio MCP server。保存后，新运行会自动通过 tools/list 发现工具，并按读/写/执行风险接入审批。
            </p>
          </div>
        </div>

        <div className="detail-block settings-section-stack">
          <div className="section-title"><h3>Provider 注册表</h3><span className="tiny">{activeProvider}</span></div>
          <div className="detail-row" style={{ alignItems: "center" }}>
            <span className="tiny">连接状态</span>
            <SignalPill tone={connectionTone}>{connectionLabel}</SignalPill>
          </div>
          <p className="muted" style={{ margin: 0 }}>{connectionResult?.detail ?? authSummary}</p>
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
              <input className="settings-input" value={providerDraft.model} onChange={(e) => patchActiveProvider((prev) => ({ ...prev, model: e.target.value }))} placeholder="deepseek-chat" />
            </div>
          </div>
          <div>
            <label className="tiny">说明</label>
            <div className="detail-row" style={{ justifyContent: "flex-start" }}>
              <span className="detail-value" style={{ textAlign: "left" }}>{CODEX_PROVIDER_HINT}</span>
            </div>
          </div>
        </div>

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
          <div className="section-title"><h4>待保存差异</h4><span className="tiny">{providerDiffItems.length + runtimeDiffItems.length} 项变更</span></div>
          {providerDiffItems.length + runtimeDiffItems.length > 0 ? (
            <div className="settings-diff-list">
              {runtimeDiffItems.map((item) => (
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
          {saveState ? <p className="muted">{saveState}</p> : null}
        </div>
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
  const [surface, setSurface] = useState<MainSurface>("home");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [decisionState, setDecisionState] = useState<Record<string, "approving" | "approved" | "denied">>({});
  const [runActionState, setRunActionState] = useState<"idle" | "cancelling" | "retrying">("idle");
  const [branchingRunId, setBranchingRunId] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<DesktopAttachment[]>([]);
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const latestErrorEvent = [...sortedEvents].reverse().find((event) => event.kind === "error");
  const canShowCompactionBanner = activeRun?.status === "running" || activeRun?.status === "paused" || activeRun?.status === "needs_approval";
  const latestCompactionEvent = canShowCompactionBanner
    ? [...sortedEvents].reverse().find((event) => event.kind === "context_compacted" && isMeaningfulCompactionEvent(event))
    : undefined;
  const hasApprovedResume = Object.values(decisionState).includes("approved") && activeRun?.status === "running";
  const currentProvider = settings?.providers[settings?.llm.provider ?? ""];
  const providerLabel = settings?.llm.provider ?? "未设置";
  const modelLabel = settings?.llm.model ?? currentProvider?.model ?? "未设置";
  const workspaceLabel = settings?.workspaceRoot?.trim() ? settings.workspaceRoot : "未设置";
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
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
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
  const runActivityMeta = [runActivity.ageLabel ? `最近事件 ${runActivity.ageLabel}` : null, runActivity.stalled ? "长等待" : null]
    .filter(Boolean)
    .join(" · ");
  const composerBlockedReason = !activeSessionId
    ? "先创建或选中一个会话。"
    : runActionState !== "idle"
      ? (runActionState === "retrying" ? "正在重试运行…" : "正在取消运行…")
      : sending
        ? "正在发送消息…"
        : activeRun?.status === "needs_approval"
          ? "运行因审批暂停，请先处理上方审批卡片后继续。"
          : settingsError
            ? "先修好模型设置，再启动下一次运行。"
            : "Shift+Enter 换行 · Enter 发送";

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
    void refreshDetail();
    void refreshSessions();
  }, [activeSessionId, sortedEvents.length, refreshDetail, refreshSessions]);

  const handleApprovalDecision = async (approvalId: string, decision: "granted" | "denied") => {
    setDecisionState((prev) => ({ ...prev, [approvalId]: "approving" }));
    try {
      const bridge = requireDesktopBridge();
      await bridge.decideApproval({ approvalId, decision });
      setApprovalError(null);
      setDecisionState((prev) => ({
        ...prev,
        [approvalId]: decision === "granted" ? "approved" : "denied",
      }));
      await refreshDetail();
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
    if (!sid || (!message.trim() && attachments.length === 0) || sending) return;
    setSending(true);
    try {
      const run = await requireDesktopBridge().sendUserMessage({ sessionId: sid, message, attachments });
      setActionError(null);
      setActiveRunId(run.id);
      setInputText("");
      setSelectedAttachments([]);
      setSessionDrafts((prev) => ({ ...prev, [sid]: "" }));
      void refreshDetail();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setActionError(`发送消息失败：${detail}`);
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
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
    if (!activeSessionId || sending || runActionState !== "idle") return;
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

  const openSettings = async () => {
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
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSaved={setSettings} />
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
        <div className="app simple-layout">
          <aside className="panel app-nav-panel">
            <div className="app-nav-top">
              <div className="brand-mark">拾</div>
              <div className="app-nav-copy">
                <strong>拾光</strong>
                <span>Agent</span>
              </div>
            </div>

            <div className="app-nav-group">
              <button className={`app-nav-btn${surface === "home" ? " active" : ""}`} type="button" onClick={() => setSurface("home")}>
                <span className="app-nav-glyph">会</span>
                <span className="app-nav-text">会话</span>
              </button>
              <button className={`app-nav-btn${showChatView ? " active" : ""}`} type="button" onClick={() => setSurface(activeSessionId ? "running" : "home")}>
                <span className="app-nav-glyph">聊</span>
                <span className="app-nav-text">聊天</span>
              </button>
              <button className="app-nav-btn" type="button" onClick={handleCreateSession}>
                <span className="app-nav-glyph">＋</span>
                <span className="app-nav-text">新建</span>
              </button>
            </div>

            <div className="app-nav-footer">
              <div className={`app-nav-status${pendingApprovals.length > 0 ? " warn" : ""}`}>
                <span>{pendingApprovals.length > 0 ? `${pendingApprovals.length} 待审` : runtimeLabel}</span>
                <small>{streamLabel}</small>
              </div>
              <button className="app-nav-btn secondary" type="button" onClick={() => { void openSettings(); }}>
                <span className="app-nav-glyph">设</span>
                <span className="app-nav-text">设置</span>
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
                    entries={sessionConversation}
                    liveEvents={sortedEvents}
                    showLiveEvents={showActiveRunTranscript}
                    pendingApprovals={pendingApprovals}
                    decisionState={decisionState}
                    onApprovalDecision={handleApprovalDecision}
                  />
                </section>

                <section className="composer composer-dock">
                  <div className="composer-hint-row">
                    <SignalPill tone={activeRun?.status === "needs_approval" ? "warn" : streamState === "error" ? "danger" : activeRun?.status === "running" ? "success" : "neutral"}>
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
                    placeholder="输入要继续推进的任务、问题或命令..."
                    disabled={!activeSessionId || sending || runActionState === "retrying"}
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
                      <button className="composer-action" type="button" onClick={() => { void handlePickAttachments(); }} disabled={!activeSessionId || sending || runActionState !== "idle"}>📎 附件{selectedAttachments.length > 0 ? ` (${selectedAttachments.length})` : ""}</button>
                      <button className="composer-action" type="button" onClick={() => { void openSettings(); }}>⚙ 模型</button>
                    </div>
                    <button className="send-btn" type="button" onClick={() => { void handleSend(); }} disabled={!activeSessionId || sending || runActionState !== "idle" || (!inputText.trim() && selectedAttachments.length === 0)}>
                      {sending ? "..." : "发送 ↗"}
                    </button>
                  </div>
                </section>
              </>
            )}
          </main>
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
                  label="工作目录"
                  value={workspaceLabel === "not set" ? "缺失" : "就绪"}
                  tone={workspaceLabel === "not set" ? "warn" : "success"}
                  detail={workspaceLabel}
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
                    <span className="tiny">工作目录</span>
                    <strong>{workspaceLabel === "not set" ? "缺失" : "就绪"}</strong>
                    <p className="muted">{workspaceLabel}</p>
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
                  <SignalPill tone={activeRun?.status === "needs_approval" ? "warn" : streamState === "error" ? "danger" : activeRun?.status === "running" ? "success" : "neutral"}>
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
                  placeholder="输入要继续推进的任务、问题或命令..."
                  disabled={!activeSessionId || sending || runActionState === "retrying"}
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
                    <button className="composer-action" type="button" onClick={() => { void handlePickAttachments(); }} disabled={!activeSessionId || sending || runActionState !== "idle"}>📎 附件{selectedAttachments.length > 0 ? ` (${selectedAttachments.length})` : ""}</button>
                    <button className="composer-action" type="button" onClick={() => { void openSettings(); }}>⚙ 模型</button>
                  </div>
                  <button className="send-btn" type="button" onClick={() => { void handleSend(); }} disabled={!activeSessionId || sending || runActionState !== "idle" || (!inputText.trim() && selectedAttachments.length === 0)}>
                    {sending ? "..." : "发送 ↗"}
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

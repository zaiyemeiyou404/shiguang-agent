import { useEffect, useMemo, useRef, useState } from "react";
import { useDesktopSessions, useRunEvents } from "./hooks/useDesktopSessions";
import { getDesktopBridge, getDesktopBridgeErrorMessage, requireDesktopBridge } from "./bridge";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSettings, DesktopApproval, DesktopArtifact } from "./bridge";

type PillVariant = "progress" | "safe" | "auto" | "todo";
type BannerVariant = "info" | "warn" | "danger" | "success";
type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini";
type ProviderAuthMode = "api_key" | "none";
type ProviderDraft = {
  key: string;
  type: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseURL: string;
  apiKeyEnv: string;
  model: string;
  maxTokens: string;
};

type SignalTone = "neutral" | "success" | "warn" | "danger" | "accent";
type MainSurface = "home" | "running" | "approval";

const CODEX_PROVIDER_HINT = "先做 Hermes 风格 API provider registry：Codex 目前走 OpenAI API 模式，不走 CLI/OAuth 登录态；其他兼容 Chat Completions 的 provider 也一样接。";

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
  const accent = variant === "danger"
    ? "#ff6b6b"
    : variant === "warn"
      ? "#ffb84d"
      : variant === "success"
        ? "var(--success)"
        : "var(--accent)";
  const background = variant === "danger"
    ? "rgba(255,107,107,0.10)"
    : variant === "warn"
      ? "rgba(255,184,77,0.10)"
      : variant === "success"
        ? "rgba(87,211,166,0.10)"
        : "rgba(140,125,255,0.10)";
  return (
    <div style={{ padding: "10px 12px", borderLeft: `3px solid ${accent}`, background, borderRadius: 12, display: "grid", gap: 4 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {detail ? <p className="muted" style={{ margin: 0 }}>{detail}</p> : null}
    </div>
  );
}

function signalToneForRunStatus(status: DesktopRun["status"] | null): SignalTone {
  if (status === "running") return "success";
  if (status === "needs_approval" || status === "pending") return "warn";
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

function SessionCard({ active, session, onClick }: {
  active?: boolean; session: DesktopSession; onClick?: () => void;
}) {
  const pillMap: Record<string, [string, PillVariant]> = {
    active: ["进行中", "progress"],
    paused: ["已暂停", "todo"],
    archived: ["已归档", "safe"],
  };
  const pill = pillMap[session.status] ?? ["进行中", "progress"];
  const attentionPills: Array<[string, PillVariant]> = [];
  if (session.attention?.hasPendingApproval) {
    attentionPills.push([`审批 ${session.attention.pendingApprovalCount}`, "todo"]);
  }
  if (session.attention?.hasRunningRun) {
    attentionPills.push(["运行中", "progress"]);
  }
  if (session.attention?.hasFailedRun) {
    attentionPills.push(["失败", "auto"]);
  }
  if (session.attention?.hasContextCompaction) {
    attentionPills.push(["已压缩", "safe"]);
  }
  const preview = session.summary ?? formatRunStatus(session.attention?.latestRunStatus) ?? formatSessionStatus(session.status);
  return (
    <article className={`session-card${active ? " active" : ""}`} onClick={onClick} style={{ cursor: "pointer" }}>
      <div className="session-top" style={{ alignItems: "flex-start", gap: 8 }}>
        <div className="session-name">{session.title}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Pill variant={pill[1]}>{pill[0]}</Pill>
          {attentionPills.map(([label, variant]) => <Pill key={label} variant={variant}>{label}</Pill>)}
        </div>
      </div>
      <p className="session-preview">{preview}</p>
      <div className="meta-line"><span>{active ? "当前会话" : (session.attention?.latestRunStatus ? `最近运行：${formatRunStatus(session.attention.latestRunStatus)}` : "")}</span></div>
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

function summarizeApprovalRequest(request: unknown): {
  toolName: string | null;
  reason: string | null;
  toolInput: string;
} {
  if (!request || typeof request !== "object") {
    return {
      toolName: null,
      reason: null,
      toolInput: formatPayload(request),
    };
  }

  const payload = request as { toolName?: unknown; toolInput?: unknown; reason?: unknown };
  return {
    toolName: typeof payload.toolName === "string" ? payload.toolName : null,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    toolInput: formatPayload(payload.toolInput),
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

function RunTimeline({ events }: { events: DesktopEvent[] }) {
  const [activeFilter, setActiveFilter] = useState<TimelineLane | "all">("all");
  const [expandedToolBlocks, setExpandedToolBlocks] = useState<Record<string, boolean>>({});

  if (events.length === 0) {
    return <p className="muted" style={{ padding: 20 }}>还没有运行事件，发一条消息就会开始。</p>;
  }

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

  return (
    <div className="timeline-stack">
      <div className="timeline-overview">
        <div className="section-title" style={{ marginBottom: 0 }}>
          <h3>运行时间线</h3>
          <span className="tiny">{filteredEvents.length} / {events.length} 条事件</span>
        </div>
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
            <article className="timeline-node event lane-tools" key={id}>
              <div className="timeline-rail">
                <div className="timeline-dot accent" />
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
            <Message key={evt.id} role="user" from="You" time={new Date(evt.createdAt).toLocaleTimeString()}>
              <p>{String((evt.payload as Record<string, unknown>)?.content ?? "")}</p>
            </Message>
          );
        }
        if (evt.kind === "message") {
          return (
            <Message key={evt.id} from="拾光 Agent" time={new Date(evt.createdAt).toLocaleTimeString()}>
              <p>{String((evt.payload as Record<string, unknown>)?.content ?? "")}</p>
            </Message>
          );
        }
        return <EventCard key={evt.id} event={evt} />;
      })}
    </div>
  );
}

function DetailRunRow({ run, active, onClick }: { run: DesktopRun; active?: boolean; onClick?: () => void }) {
  return (
    <div className="detail-row" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default", borderRadius: 10, background: active ? "rgba(140,125,255,0.10)" : undefined, padding: "6px 8px" }}>
      <span className="detail-key">{formatRunStatus(run.status)}</span>
      <span className="detail-value">{run.summary ?? run.id.slice(0, 16)}</span>
    </div>
  );
}

function ArtifactCard({
  artifact,
  onSelectRun,
}: {
  artifact: DesktopArtifact;
  onSelectRun?: (runId: string) => void;
}) {
  const summary = typeof artifact.metadata.summary === "string" ? artifact.metadata.summary : artifact.title ?? artifact.kind;
  const stepLabel = typeof artifact.metadata.steps === "number" ? `${artifact.metadata.steps} step(s)` : null;
  const plannerLabel = typeof artifact.metadata.planner === "string" ? artifact.metadata.planner : null;
  const canJump = typeof artifact.runId === "string" && artifact.runId.length > 0;
  const copySummary = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(summary);
    }
  };

  return (
    <div className="event-card" style={{ padding: "12px", background: "rgba(87,211,166,0.08)", borderLeft: "3px solid var(--success)" }}>
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{artifact.title ?? artifact.kind}</span>
        <span>{new Date(artifact.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        {artifact.kind} · {plannerLabel ?? "summary"}{stepLabel ? ` · ${stepLabel}` : ""}
      </p>
      <p className="muted" style={{ marginBottom: 8 }}>{summary.slice(0, 220) || "暂无摘要"}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canJump ? <button className="tool-btn" type="button" onClick={() => onSelectRun?.(artifact.runId!)}>定位运行</button> : null}
        <button className="tool-btn" type="button" onClick={() => { void copySummary(); }}>复制摘要</button>
      </div>
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
    <div className="event-card" style={{ padding: "12px", background: "rgba(255,184,77,0.08)", borderLeft: "3px solid #ffb84d" }}>
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{requestSummary.toolName ?? approval.capability}</span>
        <span>{statusLabel}</span>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        能力 {approval.capability} · 运行 {approval.runId.slice(0, 18)} · 插件 {approval.pluginId}
      </p>
      {requestSummary.reason ? <p className="muted" style={{ marginBottom: 8 }}>{requestSummary.reason}</p> : null}
      {requestSummary.toolInput ? <pre className="tool-json">{requestSummary.toolInput.length > 320 ? requestSummary.toolInput.slice(0, 320) + "..." : requestSummary.toolInput}</pre> : null}
      {decisionState === "approved" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>已通过，正在恢复运行…</p> : null}
      {decisionState === "denied" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>已拒绝。</p> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="tool-btn" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "denied")}>拒绝</button>
        <button className="tool-btn primary" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "granted")}>{deciding ? "处理中..." : "通过"}</button>
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
    apiKeyEnv: provider.apiKeyEnv ?? "",
    model: provider.model ?? "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
  };
}

function buildSettings(
  base: DesktopSettings,
  draft: ProviderDraft,
  workspaceRoot: string,
  activeProvider: string,
  activeModel: string,
  maxTokens: string,
): DesktopSettings {
  const parsedMaxTokens = maxTokens.trim() ? Number.parseInt(maxTokens, 10) : undefined;
  const nextProviders = { ...base.providers };
  nextProviders[draft.key] = {
    type: draft.type,
    authMode: draft.authMode,
    ...(draft.baseURL.trim() ? { baseURL: draft.baseURL.trim() } : {}),
    ...(draft.authMode !== "none" && draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
  };

  return {
    ...base,
    workspaceRoot: workspaceRoot.trim(),
    llm: {
      provider: activeProvider.trim() || "openai",
      ...(activeModel.trim() ? { model: activeModel.trim() } : {}),
      ...(Number.isFinite(parsedMaxTokens) && parsedMaxTokens ? { maxTokens: parsedMaxTokens } : {}),
    },
    providers: nextProviders,
  };
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
  const providerOptions = useMemo(() => {
    const keys = Object.keys(settings?.providers ?? {});
    return keys.length > 0 ? keys : [settings?.llm.provider ?? "openai"];
  }, [settings]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProvider, setActiveProvider] = useState("openai");
  const [activeModel, setActiveModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    key: "openai",
    type: "openai-compatible",
    authMode: "api_key",
    baseURL: "",
    apiKeyEnv: "",
    model: "",
    maxTokens: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");

  useEffect(() => {
    if (!settings || !open) return;
    const providerKey = settings.llm.provider || providerOptions[0] || "openai";
    setWorkspaceRoot(settings.workspaceRoot ?? "");
    setActiveProvider(providerKey);
    setActiveModel(settings.llm.model ?? settings.providers[providerKey]?.model ?? "");
    setMaxTokens(settings.llm.maxTokens
      ? String(settings.llm.maxTokens)
      : settings.providers[providerKey]?.maxTokens
        ? String(settings.providers[providerKey]?.maxTokens)
        : "");
    setProviderDraft(providerDraftFromSettings(settings, providerKey));
    setSaveState("");
  }, [settings, open, providerOptions]);

  if (!open || !settings) return null;

  const switchProvider = (nextKey: string) => {
    setActiveProvider(nextKey);
    setProviderDraft(providerDraftFromSettings(settings, nextKey));
    setActiveModel(settings.providers[nextKey]?.model ?? settings.llm.model ?? "");
    setMaxTokens(settings.providers[nextKey]?.maxTokens ? String(settings.providers[nextKey]?.maxTokens) : "");
  };

  const applyPreset = (draft: ProviderDraft) => {
    setActiveProvider(draft.key);
    setProviderDraft(draft);
    setActiveModel(draft.model);
    setMaxTokens(draft.maxTokens);
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = buildSettings(settings, providerDraft, workspaceRoot, activeProvider, activeModel, maxTokens);
      const saved = await requireDesktopBridge().saveSettings(next);
      onSaved(saved);
      setSaveState(`已保存到 ${saved.configPath}`);
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,14,0.58)", backdropFilter: "blur(8px)", zIndex: 20, display: "flex", justifyContent: "flex-end" }}>
      <aside className="panel" style={{ width: 460, margin: 16, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="titlebar" style={{ padding: 0, borderBottom: "none" }}>
          <div className="title-group">
            <h2>模型与 Provider 设置</h2>
            <p>Hermes / Craft 风格：当前模型 + provider 注册表</p>
          </div>
          <div className="toolbar">
            <ToolBtn onClick={onClose}>关闭</ToolBtn>
            <ToolBtn primary onClick={save}>{saving ? "保存中..." : "保存"}</ToolBtn>
          </div>
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 10 }}>
          <div className="section-title"><h3>当前配置</h3><span className="tiny">{settings.configPath}</span></div>
          <label className="tiny">工作目录</label>
          <input className="settings-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
          <label className="tiny">当前 Provider</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select className="settings-input" value={activeProvider} onChange={(e) => switchProvider(e.target.value)}>
              {providerOptions.map((key) => <option key={key} value={key}>{key}</option>)}
            </select>
            <input className="settings-input" value={providerDraft.key} onChange={(e) => setProviderDraft((prev) => ({ ...prev, key: e.target.value }))} placeholder="provider 标识" />
          </div>
          <label className="tiny">模型</label>
          <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-chat / gpt-5 / openai/gpt-5" />
          <label className="tiny">最大 Tokens</label>
          <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 10 }}>
          <div className="section-title"><h3>Provider 注册表</h3><span className="tiny">API 模式</span></div>
          <label className="tiny">协议</label>
          <select className="settings-input" value={providerDraft.type} onChange={(e) => setProviderDraft((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
            <option value="openai-compatible">openai-compatible</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
          <label className="tiny">鉴权方式</label>
          <select className="settings-input" value={providerDraft.authMode} onChange={(e) => setProviderDraft((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
            <option value="api_key">api_key</option>
            <option value="none">none</option>
          </select>
          <label className="tiny">Base URL</label>
          <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => setProviderDraft((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
          <label className="tiny">API Key 环境变量</label>
          <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => setProviderDraft((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "不需要" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
          <label className="tiny">默认模型</label>
          <input className="settings-input" value={providerDraft.model} onChange={(e) => setProviderDraft((prev) => ({ ...prev, model: e.target.value }))} placeholder="deepseek-chat" />
          <label className="tiny">说明</label>
          <div className="detail-row" style={{ justifyContent: "flex-start" }}>
            <span className="detail-value" style={{ textAlign: "left" }}>{CODEX_PROVIDER_HINT}</span>
          </div>
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 8 }}>
          <h4>快捷预设</h4>
          <div className="legend" style={{ display: "grid", gap: 8 }}>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "deepseek", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat", maxTokens: "4096" })}>DeepSeek</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "openai", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" })}>OpenAI API</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "codex-api", type: "openai-compatible", authMode: "api_key", baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-5", maxTokens: "4096" })}>Codex / OpenAI API</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "openrouter", type: "openai-compatible", authMode: "api_key", baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-5", maxTokens: "4096" })}>OpenRouter</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "anthropic", type: "anthropic", authMode: "api_key", baseURL: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-3-5-sonnet-latest", maxTokens: "4096" })}>Anthropic</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "gemini", type: "gemini", authMode: "api_key", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY", model: "gemini-2.5-pro", maxTokens: "4096" })}>Gemini</button>
            <button className="tool-btn" type="button" onClick={() => applyPreset({ key: "ollama", type: "openai-compatible", authMode: "none", baseURL: "http://127.0.0.1:11434/v1", apiKeyEnv: "", model: "qwen2.5-coder:14b", maxTokens: "4096" })}>Ollama</button>
          </div>
          {saveState ? <p className="muted">{saveState}</p> : null}
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const desktopBridge = getDesktopBridge();
  const hostMismatch = !desktopBridge;
  const { sessions, activeSessionId, detail, activeRunId, setActiveRunId, loading, sessionError, detailError, createSession, selectSession, refreshSessions, refreshDetail } = useDesktopSessions();
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [surface, setSurface] = useState<MainSurface>("home");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<DesktopApproval[]>([]);
  const [artifacts, setArtifacts] = useState<DesktopArtifact[]>([]);
  const [decisionState, setDecisionState] = useState<Record<string, "approving" | "approved" | "denied">>({});
  const [runActionState, setRunActionState] = useState<"idle" | "cancelling" | "retrying">("idle");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { events, eventsError, streamState } = useRunEvents(activeRunId);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const activeRun = detail?.runs?.find((r) => r.id === activeRunId) ?? null;
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const latestErrorEvent = [...sortedEvents].reverse().find((event) => event.kind === "error");
  const latestCompactionEvent = [...sortedEvents].reverse().find((event) => event.kind === "context_compacted");
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
      const priorityDiff = sessionPriority(b, activeSessionId) - sessionPriority(a, activeSessionId);
      if (priorityDiff !== 0) return priorityDiff;
      return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt);
    });
  }, [activeSessionId, sessions]);
  const latestSession = sortedSessions[0] ?? null;
  const visibleArtifacts = useMemo(() => activeRunId ? artifacts.filter((artifact) => artifact.runId === activeRunId) : artifacts, [activeRunId, artifacts]);
  const surfaceTitle = surface === "home"
    ? "拾光首页"
    : surface === "approval"
      ? "待审批动作"
      : (detail?.session?.title ?? "运行中会话");
  const surfaceSubtitle = surface === "home"
    ? "从入口、状态、审批和产物直接进入工作"
    : surface === "approval"
      ? "集中处理有副作用的关键动作"
      : (activeRun ? `运行状态：${formatRunStatus(activeRun.status)}` : (detail ? `${detail.runs.length} 次运行` : "选择一个会话开始"));
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
  const composerBlockedReason = !activeSessionId
    ? "先创建或选中一个会话。"
    : runActionState !== "idle"
      ? (runActionState === "retrying" ? "正在重试运行…" : "正在取消运行…")
      : sending
        ? "正在发送消息…"
        : activeRun?.status === "needs_approval"
          ? "运行因审批暂停，请在右侧面板通过或拒绝后继续。"
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
    if (!activeSessionId) {
      setPendingApprovals([]);
      return;
    }
    if (!desktopBridge) {
      setApprovalError(getDesktopBridgeErrorMessage());
      return;
    }
    void desktopBridge.listPendingApprovals(activeSessionId).then((approvals) => {
      setPendingApprovals(approvals);
      setApprovalError(null);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setApprovalError(`加载待审批列表失败：${message}`);
    });
  }, [activeSessionId, activeRunId, desktopBridge, sortedEvents.length]);

  useEffect(() => {
    if (!activeSessionId) {
      setArtifacts([]);
      return;
    }
    if (!desktopBridge) {
      setArtifactError(getDesktopBridgeErrorMessage());
      return;
    }
    void desktopBridge.listArtifacts(activeSessionId).then((items) => {
      setArtifacts(items);
      setArtifactError(null);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setArtifactError(`加载运行产物失败：${message}`);
    });
  }, [activeSessionId, desktopBridge, detail?.runs.length, sortedEvents.length]);

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
      if (activeSessionId) {
        setPendingApprovals(await bridge.listPendingApprovals(activeSessionId));
      }
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

  const handleSend = async () => {
    if (!inputText.trim() || sending) return;
    const sid = activeSessionId;
    if (!sid) return;
    setSending(true);
    try {
      const run = await requireDesktopBridge().sendUserMessage({ sessionId: sid, message: inputText });
      setActionError(null);
      setActiveRunId(run.id);
      setInputText("");
      void refreshDetail();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`发送消息失败：${message}`);
    } finally {
      setSending(false);
    }
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
      if (activeSessionId) {
        setPendingApprovals(await bridge.listPendingApprovals(activeSessionId));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`取消运行失败：${message}`);
    } finally {
      setRunActionState("idle");
    }
  };

  const handleRetryRun = async () => {
    if (!activeRun || runActionState !== "idle") return;
    setRunActionState("retrying");
    try {
      const run = await requireDesktopBridge().retryRun({ runId: activeRun.id });
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

  const handleCreateSession = async () => {
    const title = prompt("会话标题：", "新会话");
    if (title !== null) {
      try {
        await createSession(title || undefined);
        setActionError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(`创建会话失败：${message}`);
      }
    }
  };

  const handleAutoAction = async () => {
    if (pendingApprovals.length > 0) {
      setSurface("approval");
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
    if (!inputText.trim() && !activeRun) {
      setInputText("继续当前任务，先检查最近状态、可用产物和下一步。");
    }
    setTimeout(() => composerRef.current?.focus(), 0);
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

      <div className="app">
        <aside className="panel sidebar">
          <div className="brand">
            <div className="brand-badge">
              <div className="brand-mark">拾</div>
              <div>
                <h1>拾光 Agent</h1>
                <p>桌面端 · 实时</p>
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
            <SurfaceNavButton active={surface === "home"} label="首页" onClick={() => setSurface("home")} />
            <SurfaceNavButton active={surface === "running"} label="运行中" count={activeRun ? "实时" : undefined} onClick={() => setSurface("running")} />
            <SurfaceNavButton active={surface === "approval"} label="待审批" count={pendingApprovals.length > 0 ? String(pendingApprovals.length) : undefined} onClick={() => setSurface("approval")} />
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>
            <h3>会话</h3>
            <span className="tiny">{sessions.length} 个会话 · 已按优先级排序</span>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <p className="muted" style={{ padding: 16 }}>还没有会话，点 ＋ 新建一个。</p>
            )}
            {sortedSessions.map((s) => (
              <SessionCard
                key={s.id}
                active={s.id === activeSessionId}
                session={s}
                onClick={() => selectSession(s.id)}
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
                <ToolBtn onClick={() => { void handleRetryRun(); }}>{runActionState === "retrying" ? "重试中..." : "重新运行"}</ToolBtn>
              ) : null}
              <ToolBtn onClick={openSettings}>模型设置</ToolBtn>
              <ToolBtn primary onClick={() => { void handleAutoAction(); }}>自动</ToolBtn>
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
            {artifactError ? (
              <GlobalBanner variant="warn" title="运行产物不可用" detail={artifactError} />
            ) : null}
            {actionError ? (
              <GlobalBanner variant="danger" title="桌面动作失败" detail={actionError} />
            ) : null}
            {pendingApprovals.length > 0 ? (
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
                  <h3>拾光 Agent 首页</h3>
                  <SignalPill tone={pendingApprovals.length > 0 ? "warn" : "accent"}>{pendingApprovals.length > 0 ? `${pendingApprovals.length} 个待审批` : "工作台就绪"}</SignalPill>
                </div>
                <h1>今天想让拾光 Agent 帮你推进什么？</h1>
                <p className="muted">把继续任务、审批、模型配置和运行时间线直接做成真实入口，不再只是一个空聊天框。</p>
                <div className="home-command-bar">
                  <button className="home-command-chip" type="button" onClick={() => setSurface("running")}>继续最近运行</button>
                  <button className="home-command-chip" type="button" onClick={() => setSurface("approval")}>先处理审批</button>
                  <button className="home-command-chip" type="button" onClick={() => { void openSettings(); }}>切到模型设置</button>
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
              </section>

              <section className="home-summary-grid">
                <div className="detail-block home-summary-block">
                  <div className="section-title"><h4>最近会话</h4><span className="tiny">前 3 个</span></div>
                  <div className="home-list">
                    {sortedSessions.slice(0, 3).map((session) => (
                      <button key={session.id} className="home-list-row" type="button" onClick={() => { selectSession(session.id); setSurface("running"); }}>
                        <strong>{session.title}</strong>
                        <span className="tiny">{session.attention?.latestRunStatus ? formatRunStatus(session.attention.latestRunStatus) : formatSessionStatus(session.status)}</span>
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
              </section>
            </>
          ) : null}

          {surface === "running" ? (
            <>
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
              </section>

              <section className="chat-scroll">
                <RunTimeline events={sortedEvents} />
              </section>

              <section className="composer">
                <div className="composer-hint-row">
                  <SignalPill tone={activeRun?.status === "needs_approval" ? "warn" : streamState === "error" ? "danger" : activeRun?.status === "running" ? "success" : "neutral"}>
                    {activeRun?.status === "needs_approval" ? "需要审批" : activeRun ? formatRunStatus(activeRun.status) : "就绪"}
                  </SignalPill>
                  <p className="muted">{composerBlockedReason}</p>
                </div>
                <textarea
                  ref={composerRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="输入要继续推进的任务、问题或命令..."
                  disabled={!activeSessionId || sending || runActionState === "retrying"}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
                />
                <div className="composer-footer">
                  <div className="composer-actions">
                    <button className="composer-action" type="button" disabled={!activeSessionId || sending || runActionState !== "idle"}>📎 附件</button>
                    <button className="composer-action" type="button" onClick={() => { void openSettings(); }}>⚙ 模型</button>
                  </div>
                  <button className="send-btn" type="button" onClick={() => { void handleSend(); }} disabled={!activeSessionId || sending || runActionState !== "idle" || !inputText.trim()}>
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
                      <ApprovalCard
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
                        <span className="detail-key">{formatEventKindLabel(event.kind)}</span>
                        <p className="muted">{String(((event.payload as Record<string, unknown> | undefined)?.message) ?? ((event.payload as Record<string, unknown> | undefined)?.content) ?? formatPayload(event.payload)).slice(0, 96) || "暂无细节"}</p>
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
                    <DetailRunRow key={r.id} run={r} active={r.id === activeRunId} onClick={() => setActiveRunId(r.id)} />
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
                    <ApprovalCard
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
                      onSelectRun={(runId) => { setActiveRunId(runId); setSurface("running"); }}
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
    </div>
  );
}

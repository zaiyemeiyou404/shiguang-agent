import { useEffect, useMemo, useState } from "react";
import { useDesktopSessions, useRunEvents } from "./hooks/useDesktopSessions";
import type { DesktopSession, DesktopRun, DesktopEvent, DesktopSettings, DesktopApproval } from "./bridge";

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

function SessionCard({ active, session, onClick }: {
  active?: boolean; session: DesktopSession; onClick?: () => void;
}) {
  const pillMap: Record<string, [string, PillVariant]> = {
    active: ["Active", "progress"],
    paused: ["Paused", "todo"],
    archived: ["Archived", "safe"],
  };
  const pill = pillMap[session.status] ?? ["Active", "progress"];
  const attentionPills: Array<[string, PillVariant]> = [];
  if (session.attention?.hasPendingApproval) {
    attentionPills.push([`Approval${session.attention.pendingApprovalCount > 1 ? ` ${session.attention.pendingApprovalCount}` : ""}`, "todo"]);
  }
  if (session.attention?.hasRunningRun) {
    attentionPills.push(["Running", "progress"]);
  }
  if (session.attention?.hasFailedRun) {
    attentionPills.push(["Failed", "auto"]);
  }
  if (session.attention?.hasContextCompaction) {
    attentionPills.push(["Compacted", "safe"]);
  }
  const preview = session.summary ?? session.attention?.latestRunStatus ?? session.status;
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
      <div className="meta-line"><span>{active ? "current" : (session.attention?.latestRunStatus ? `last run: ${session.attention.latestRunStatus}` : "")}</span></div>
    </article>
  );
}

function Message({ role, from, time, children }: {
  role?: "user" | "system"; from: string; time: string; children: React.ReactNode;
}) {
  return (
    <article className={`message${role ? " " + role : ""}`}>
      <div className="message-meta"><span>{from}</span><span>{time}</span></div>
      {children}
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

function EventCard({ kind, payload }: { kind: string; payload: unknown }) {
  const p = payload as Record<string, unknown> | undefined;
  const toolName = p?.tool ?? p?.role ?? kind;
  const isObjectPayload = typeof payload === "object" && payload !== null && !(payload as Record<string, unknown>)?.content;

  if (kind === "approval_request" || kind === "approval_granted" || kind === "approval_denied") {
    const requestSummary = summarizeApprovalRequest(p?.request);
    const capability = typeof p?.capability === "string" ? p.capability : "approval";
    const title = kind === "approval_request"
      ? "Approval requested"
      : kind === "approval_granted"
        ? "Approval granted"
        : "Approval denied";
    const accent = kind === "approval_denied" ? "#ff6b6b" : kind === "approval_granted" ? "var(--success)" : "#ffb84d";
    return (
      <div className="event-card" style={{ padding: "10px 12px", background: "rgba(255,184,77,0.08)", borderLeft: `3px solid ${accent}` }}>
        <div className="message-meta" style={{ marginBottom: 6 }}>
          <span>{title}</span>
          <span>{capability}</span>
        </div>
        <p className="muted" style={{ marginBottom: 8 }}>
          {requestSummary.toolName ? `tool ${requestSummary.toolName}` : "high-risk action"}
          {requestSummary.reason ? ` · ${requestSummary.reason}` : ""}
        </p>
        {requestSummary.toolInput ? <pre className="tool-json">{requestSummary.toolInput.length > 320 ? requestSummary.toolInput.slice(0, 320) + "..." : requestSummary.toolInput}</pre> : null}
      </div>
    );
  }

  if (kind === "context_compacted") {
    const originalBudget = typeof p?.originalBudget === "number" ? p.originalBudget : null;
    const finalBudget = typeof p?.finalBudget === "number" ? p.finalBudget : null;
    const prunedCount = typeof p?.prunedCount === "number" ? p.prunedCount : 0;
    const compressedCount = typeof p?.compressedCount === "number" ? p.compressedCount : 0;
    const usedLlmCompactor = Boolean(p?.usedLlmCompactor);
    return (
      <div className="event-card" style={{ padding: "10px 12px", background: "rgba(98,163,255,0.08)", borderLeft: "3px solid #62a3ff" }}>
        <div className="message-meta" style={{ marginBottom: 6 }}>
          <span>Context compacted</span>
          <span>{usedLlmCompactor ? "llm" : "rule"}</span>
        </div>
        <p className="muted" style={{ marginBottom: 8 }}>
          {typeof p?.message === "string" ? p.message : "Older context was compacted to stay within budget."}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {originalBudget !== null && finalBudget !== null ? `budget ~${originalBudget} → ~${finalBudget}` : "budget adjusted"}
          {` · pruned ${prunedCount} · digested ${compressedCount}`}
        </p>
      </div>
    );
  }

  if (kind === "tool_call") {
    return (
      <div className="event-card" style={{ padding: "10px 12px", background: "rgba(140,125,255,0.06)", borderLeft: "3px solid var(--accent)" }}>
        <div className="message-meta" style={{ marginBottom: 6 }}>
          <span>&#8594; {String(toolName)}</span>
          <span>tool_call</span>
        </div>
        <pre className="tool-json">{formatPayload(p?.input ?? "")}</pre>
      </div>
    );
  }

  if (kind === "tool_result") {
    const outStr = formatPayload(p?.output);
    const truncated = outStr.length > 500 ? outStr.slice(0, 500) + "..." : outStr;
    return (
      <div className="event-card" style={{ padding: "10px 12px", background: "rgba(87,211,166,0.05)", borderLeft: "3px solid var(--success)" }}>
        <div className="message-meta" style={{ marginBottom: 6 }}>
          <span>&#8592; {String(toolName)} result</span>
          <span>tool_result</span>
        </div>
        <pre className="tool-json">{truncated}</pre>
      </div>
    );
  }

  const content = p?.content ?? p?.message ?? (isObjectPayload ? formatPayload(payload) : JSON.stringify(payload));
  return (
    <div className="event-card" style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)" }}>
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{String(toolName)}</span>
        <span>{kind}</span>
      </div>
      <p className="muted">{String(content).slice(0, 300)}</p>
    </div>
  );
}

function RunTimeline({ events }: { events: DesktopEvent[] }) {
  if (events.length === 0) {
    return <p className="muted" style={{ padding: 20 }}>No events yet. Send a message to start.</p>;
  }
  return (
    <>
      {events.map((evt) => {
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
        return <EventCard key={evt.id} kind={evt.kind} payload={evt.payload} />;
      })}
    </>
  );
}

function DetailRunRow({ run, active, onClick }: { run: DesktopRun; active?: boolean; onClick?: () => void }) {
  return (
    <div className="detail-row" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default", borderRadius: 10, background: active ? "rgba(140,125,255,0.10)" : undefined, padding: "6px 8px" }}>
      <span className="detail-key">{run.status}</span>
      <span className="detail-value">{run.summary ?? run.id.slice(0, 16)}</span>
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
    ? "approving"
    : decisionState === "approved"
      ? "approved"
      : decisionState === "denied"
        ? "denied"
        : approval.status;
  return (
    <div className="event-card" style={{ padding: "12px", background: "rgba(255,184,77,0.08)", borderLeft: "3px solid #ffb84d" }}>
      <div className="message-meta" style={{ marginBottom: 6 }}>
        <span>{requestSummary.toolName ?? approval.capability}</span>
        <span>{statusLabel}</span>
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        capability {approval.capability} · run {approval.runId.slice(0, 18)} · plugin {approval.pluginId}
      </p>
      {requestSummary.reason ? <p className="muted" style={{ marginBottom: 8 }}>{requestSummary.reason}</p> : null}
      {requestSummary.toolInput ? <pre className="tool-json">{requestSummary.toolInput.length > 320 ? requestSummary.toolInput.slice(0, 320) + "..." : requestSummary.toolInput}</pre> : null}
      {decisionState === "approved" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>Approved — resuming run…</p> : null}
      {decisionState === "denied" ? <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>Denied.</p> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="tool-btn" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "denied")}>Deny</button>
        <button className="tool-btn primary" type="button" disabled={deciding} onClick={() => onDecision(approval.id, "granted")}>{deciding ? "Approving..." : "Approve"}</button>
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
      const saved = await window.shiguang.saveSettings(next);
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
            <h2>AI Settings</h2>
            <p>Hermes/Craft 风格：当前模型 + provider registry</p>
          </div>
          <div className="toolbar">
            <ToolBtn onClick={onClose}>Close</ToolBtn>
            <ToolBtn primary onClick={save}>{saving ? "Saving..." : "Save"}</ToolBtn>
          </div>
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 10 }}>
          <div className="section-title"><h3>Current Config</h3><span className="tiny">{settings.configPath}</span></div>
          <label className="tiny">Workspace Root</label>
          <input className="settings-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
          <label className="tiny">Active Provider</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select className="settings-input" value={activeProvider} onChange={(e) => switchProvider(e.target.value)}>
              {providerOptions.map((key) => <option key={key} value={key}>{key}</option>)}
            </select>
            <input className="settings-input" value={providerDraft.key} onChange={(e) => setProviderDraft((prev) => ({ ...prev, key: e.target.value }))} placeholder="provider key" />
          </div>
          <label className="tiny">Model</label>
          <input className="settings-input" value={activeModel} onChange={(e) => setActiveModel(e.target.value)} placeholder="deepseek-chat / gpt-5 / openai/gpt-5" />
          <label className="tiny">Max Tokens</label>
          <input className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="4096" />
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 10 }}>
          <div className="section-title"><h3>Provider Registry</h3><span className="tiny">API modes</span></div>
          <label className="tiny">Protocol</label>
          <select className="settings-input" value={providerDraft.type} onChange={(e) => setProviderDraft((prev) => ({ ...prev, type: e.target.value as ProviderProtocol }))}>
            <option value="openai-compatible">openai-compatible</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
          <label className="tiny">Auth Mode</label>
          <select className="settings-input" value={providerDraft.authMode} onChange={(e) => setProviderDraft((prev) => ({ ...prev, authMode: e.target.value as ProviderAuthMode }))}>
            <option value="api_key">api_key</option>
            <option value="none">none</option>
          </select>
          <label className="tiny">Base URL</label>
          <input className="settings-input" value={providerDraft.baseURL} onChange={(e) => setProviderDraft((prev) => ({ ...prev, baseURL: e.target.value }))} placeholder="https://api.deepseek.com/v1" />
          <label className="tiny">API Key Env</label>
          <input className="settings-input" value={providerDraft.apiKeyEnv} onChange={(e) => setProviderDraft((prev) => ({ ...prev, apiKeyEnv: e.target.value }))} placeholder={providerDraft.authMode === "none" ? "not required" : "DEEPSEEK_API_KEY"} disabled={providerDraft.authMode === "none"} />
          <label className="tiny">Default Model</label>
          <input className="settings-input" value={providerDraft.model} onChange={(e) => setProviderDraft((prev) => ({ ...prev, model: e.target.value }))} placeholder="deepseek-chat" />
          <label className="tiny">Notes</label>
          <div className="detail-row" style={{ justifyContent: "flex-start" }}>
            <span className="detail-value" style={{ textAlign: "left" }}>{CODEX_PROVIDER_HINT}</span>
          </div>
        </div>

        <div className="detail-block" style={{ display: "grid", gap: 8 }}>
          <h4>Quick Presets</h4>
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
  const { sessions, activeSessionId, detail, activeRunId, setActiveRunId, loading, createSession, selectSession, refreshSessions, refreshDetail } = useDesktopSessions();
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<DesktopApproval[]>([]);
  const [decisionState, setDecisionState] = useState<Record<string, "approving" | "approved" | "denied">>({});
  const [runActionState, setRunActionState] = useState<"idle" | "cancelling" | "retrying">("idle");
  const events = useRunEvents(activeRunId);

  const activeRun = detail?.runs?.find((r) => r.id === activeRunId) ?? null;
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const latestErrorEvent = [...sortedEvents].reverse().find((event) => event.kind === "error");
  const latestCompactionEvent = [...sortedEvents].reverse().find((event) => event.kind === "context_compacted");
  const hasApprovedResume = Object.values(decisionState).includes("approved") && activeRun?.status === "running";

  useEffect(() => {
    void window.shiguang.getSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setPendingApprovals([]);
      return;
    }
    void window.shiguang.listPendingApprovals(activeSessionId).then(setPendingApprovals).catch(() => {});
  }, [activeSessionId, activeRunId, sortedEvents.length]);


  useEffect(() => {
    if (!activeSessionId) return;
    void refreshDetail();
    void refreshSessions();
  }, [activeSessionId, sortedEvents.length, refreshDetail, refreshSessions]);

  const handleApprovalDecision = async (approvalId: string, decision: "granted" | "denied") => {
    setDecisionState((prev) => ({ ...prev, [approvalId]: "approving" }));
    try {
      await window.shiguang.decideApproval({ approvalId, decision });
      setDecisionState((prev) => ({
        ...prev,
        [approvalId]: decision === "granted" ? "approved" : "denied",
      }));
      if (activeSessionId) {
        setPendingApprovals(await window.shiguang.listPendingApprovals(activeSessionId));
      }
      await refreshDetail();
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
      const run = await window.shiguang.sendUserMessage({ sessionId: sid, message: inputText });
      setActiveRunId(run.id);
      setInputText("");
      void refreshDetail();
    } finally {
      setSending(false);
    }
  };


  const handleCancelRun = async () => {
    if (!activeRun || runActionState !== "idle") return;
    setRunActionState("cancelling");
    try {
      const run = await window.shiguang.cancelRun({ runId: activeRun.id });
      setActiveRunId(run.id);
      await refreshDetail();
      await refreshSessions();
      if (activeSessionId) {
        setPendingApprovals(await window.shiguang.listPendingApprovals(activeSessionId));
      }
    } finally {
      setRunActionState("idle");
    }
  };

  const handleRetryRun = async () => {
    if (!activeRun || runActionState !== "idle") return;
    setRunActionState("retrying");
    try {
      const run = await window.shiguang.retryRun({ runId: activeRun.id });
      setActiveRunId(run.id);
      await refreshDetail();
      await refreshSessions();
    } finally {
      setRunActionState("idle");
    }
  };

  const handleCreateSession = async () => {
    const title = prompt("Session title:", "New Session");
    if (title !== null) {
      await createSession(title || undefined);
    }
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    try {
      setSettings(await window.shiguang.getSettings());
    } catch {
    }
  };

  if (loading) {
    return <div className="shell"><p style={{ padding: 40, color: "#888" }}>Loading...</p></div>;
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
                <p>Desktop · Live</p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <IconBtn label="Settings" onClick={openSettings}>⚙</IconBtn>
              <IconBtn label="New session" onClick={handleCreateSession}>＋</IconBtn>
            </div>
          </div>

          <div className="detail-block" style={{ padding: 12 }}>
            <div className="section-title">
              <h3>Active Model</h3>
              <span className="tiny">hermes-like</span>
            </div>
            <div className="meta-line" style={{ marginTop: 0 }}>
              <span>{settings?.llm.provider ?? "openai"}</span>
              <span>{settings?.llm.model ?? "unset"}</span>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>{settings?.configPath ?? "No config loaded"}</p>
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>
            <h3>Sessions</h3>
            <span className="tiny">{sessions.length} sessions</span>
          </div>

          <div className="session-list">
            {sessions.length === 0 && (
              <p className="muted" style={{ padding: 16 }}>No sessions yet. Click ＋ to create one.</p>
            )}
            {sessions.map((s) => (
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
              <h2>{detail?.session?.title ?? "No Session"}</h2>
              <p>{activeRun ? `Run: ${activeRun.status}` : (detail ? `${detail.runs.length} runs` : "Select a session")}</p>
            </div>
            <div className="toolbar">
              {activeRun && (activeRun.status === "pending" || activeRun.status === "running" || activeRun.status === "needs_approval") ? (
                <ToolBtn onClick={() => { void handleCancelRun(); }}>{runActionState === "cancelling" ? "Cancelling..." : "Cancel Run"}</ToolBtn>
              ) : null}
              {activeRun ? (
                <ToolBtn onClick={() => { void handleRetryRun(); }}>{runActionState === "retrying" ? "Retrying..." : "Retry Run"}</ToolBtn>
              ) : null}
              <ToolBtn onClick={openSettings}>AI Settings</ToolBtn>
              <ToolBtn primary>Auto</ToolBtn>
            </div>
          </header>

          <section style={{ display: "grid", gap: 10, padding: "12px 18px 0" }}>
            {pendingApprovals.length > 0 ? (
              <GlobalBanner
                variant="warn"
                title={`Pending approval${pendingApprovals.length > 1 ? "s" : ""}: ${pendingApprovals.length}`}
                detail="High-risk actions are waiting for review. Approve or deny them in the right panel."
              />
            ) : null}
            {latestErrorEvent ? (
              <GlobalBanner
                variant="danger"
                title="Run error"
                detail={String(((latestErrorEvent.payload as Record<string, unknown> | undefined)?.message) ?? activeRun?.reason ?? "Run failed.")}
              />
            ) : null}
            {latestCompactionEvent ? (
              <GlobalBanner
                variant="info"
                title="Context compacted"
                detail={String(((latestCompactionEvent.payload as Record<string, unknown> | undefined)?.message) ?? "Older context was compacted to fit the model budget.")}
              />
            ) : null}
            {hasApprovedResume ? (
              <GlobalBanner
                variant="success"
                title="Approval granted — run resumed"
                detail="The blocked action was approved and the agent is continuing from the paused run."
              />
            ) : null}
          </section>

          <section className="chat-scroll">
            <RunTimeline events={sortedEvents} />
          </section>

          <section className="composer">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type a message..."
              disabled={!activeSessionId || sending || runActionState === "retrying"}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
            />
            <div className="composer-footer">
              <div className="composer-actions">
                <button className="composer-action" type="button" disabled={!activeSessionId || sending || runActionState !== "idle"}>📎 Attach</button>
                <button className="composer-action" type="button" onClick={() => { void openSettings(); }}>⚙ Model</button>
              </div>
              <button className="send-btn" type="button" onClick={() => { void handleSend(); }} disabled={!activeSessionId || sending || runActionState !== "idle" || !inputText.trim()}>
                {sending ? "..." : "Send ↗"}
              </button>
            </div>
          </section>
        </main>

        <aside className="panel detail">
          <div className="section-title">
            <h3>Session Detail</h3>
            <span className="tiny">run info</span>
          </div>

          <div className="detail-scroll">
            <section className="detail-block">
              <h4>Configured Providers</h4>
              {settings && Object.keys(settings.providers).length > 0 ? Object.entries(settings.providers).map(([key, provider]) => (
                <div className="detail-row" key={key}>
                  <span className="detail-key">{key}</span>
                  <span className="detail-value">{provider.model ?? provider.apiKeyEnv ?? provider.authMode ?? "configured"}</span>
                </div>
              )) : <p className="muted">Use AI Settings to add DeepSeek / Codex / OpenRouter / Ollama.</p>}
            </section>

            {detail && (
              <section className="detail-block">
                <h4>Runs</h4>
                {detail.runs.length === 0 && <p className="muted">No runs yet.</p>}
                {detail.runs.map((r) => (
                  <DetailRunRow key={r.id} run={r} active={r.id === activeRunId} onClick={() => setActiveRunId(r.id)} />
                ))}
              </section>
            )}

            {activeRun && (
              <section className="detail-block">
                <h4>Current Run</h4>
                <div className="detail-grid">
                  <div className="detail-row">
                    <span className="detail-key">Status</span>
                    <span className="detail-value">{activeRun.status}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-key">Events</span>
                    <span className="detail-value">{sortedEvents.length}</span>
                  </div>
                </div>
                {activeRun.status === "needs_approval" ? (
                  <p className="muted" style={{ marginTop: 10 }}>This stop came from policy gating. Approve/deny below. Approving will automatically resume the blocked run.</p>
                ) : null}
              </section>
            )}

            <section className="detail-block">
              <div className="section-title">
                <h4>Pending Approvals</h4>
                <span className="tiny">{pendingApprovals.length}</span>
              </div>
              {pendingApprovals.length === 0 ? <p className="muted">No pending approvals.</p> : (
                <div className="legend" style={{ display: "grid", gap: 10 }}>
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
              <h4>Legend</h4>
              <div className="legend">
                <span><i className="dot purple" />Active session</span>
                <span><i className="dot green" />Run active</span>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useDesktopSessions, useRunEvents } from "./hooks/useDesktopSessions";
import type { DesktopRun, DesktopEvent } from "./bridge";

type PillVariant = "progress" | "safe" | "auto" | "todo";

function Pill({ variant, children }: { variant: PillVariant; children: React.ReactNode }) {
  return <span className={`pill ${variant}`}>{children}</span>;
}

function IconBtn({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return <button className="icon-btn" type="button" aria-label={label} onClick={onClick}>{children}</button>;
}

function ToolBtn({ primary, children, onClick }: { primary?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return <button className={`tool-btn${primary ? " primary" : ""}`} type="button" onClick={onClick}>{children}</button>;
}

function SessionCard({ active, title, status, onClick }: {
  active?: boolean; title: string; status: string; onClick?: () => void;
}) {
  const pillMap: Record<string, [string, PillVariant]> = {
    active: ["Active", "progress"],
    paused: ["Paused", "todo"],
    archived: ["Archived", "safe"],
  };
  const pill = pillMap[status] ?? ["Active", "progress"];
  return (
    <article className={`session-card${active ? " active" : ""}`} onClick={onClick} style={{ cursor: "pointer" }}>
      <div className="session-top">
        <div className="session-name">{title}</div>
        <Pill variant={pill[1]}>{pill[0]}</Pill>
      </div>
      <p className="session-preview">{status}</p>
      <div className="meta-line"><span>{active ? "current" : ""}</span></div>
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

function EventCard({ kind, payload }: { kind: string; payload: unknown }) {
  const p = payload as Record<string, unknown> | undefined;
  const toolName = p?.tool ?? p?.role ?? kind;
  const isObjectPayload = typeof payload === "object" && payload !== null && !(payload as Record<string, unknown>)?.content;

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
    const out = p?.output;
    const outStr = formatPayload(out);
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

function DetailRunRow({ run }: { run: DesktopRun }) {
  return (
    <div className="detail-row">
      <span className="detail-key">{run.status}</span>
      <span className="detail-value">{run.summary ?? run.id.slice(0, 16)}</span>
    </div>
  );
}

export default function App() {
  const { sessions, activeSessionId, detail, activeRunId, setActiveRunId, loading, createSession, selectSession, refreshDetail } = useDesktopSessions();
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const events = useRunEvents(activeRunId);

  const activeRun = detail?.runs?.find((r) => r.id === activeRunId) ?? null;
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

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
    } catch {
    } finally {
      setSending(false);
    }
  };

  const handleCreateSession = async () => {
    const title = prompt("Session title:", "New Session");
    if (title !== null) {
      await createSession(title || undefined);
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
            <IconBtn label="New session" onClick={handleCreateSession}>＋</IconBtn>
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
                title={s.title}
                status={s.status}
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
              <ToolBtn primary>Auto</ToolBtn>
            </div>
          </header>

          <section className="chat-scroll">
            <RunTimeline events={sortedEvents} />
          </section>

          <section className="composer">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type a message..."
              disabled={!activeSessionId || sending}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            />
            <div className="composer-footer">
              <div className="composer-actions">
                <button className="composer-action" type="button" disabled={!activeSessionId || sending}>📎 Attach</button>
              </div>
              <button className="send-btn" type="button" onClick={handleSend} disabled={!activeSessionId || sending || !inputText.trim()}>
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
            {detail && (
              <section className="detail-block">
                <h4>Runs</h4>
                {detail.runs.length === 0 && <p className="muted">No runs yet.</p>}
                {detail.runs.map((r) => (
                  <DetailRunRow key={r.id} run={r} />
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
              </section>
            )}

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

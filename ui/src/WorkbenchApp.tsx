import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Brain,
  ChatCircle,
  Checks,
  DotsThree,
  File,
  FolderSimple,
  GearSix,
  GitBranch,
  MagnifyingGlass,
  Paperclip,
  PaperPlaneRight,
  Pause,
  Planet,
  Plus,
  SidebarSimple,
  SpinnerGap,
  Stop,
  Wrench,
  X,
} from "@phosphor-icons/react";

import {
  getDesktopBridge,
  getDesktopBridgeErrorMessage,
  requireDesktopBridge,
  type DesktopAttachment,
  type DesktopRun,
  type DesktopSettings,
} from "./bridge";
import { ActivityFeed } from "./features/activity/ActivityFeed";
import type { ApprovalDecisionState } from "./features/approvals/ApprovalCard";
import { SettingsDrawer, type SettingsDrawerMode } from "./features/settings/SettingsDrawer";
import { ArtifactPanel } from "./features/workbench/ArtifactPanel";
import { ApprovalPanel } from "./features/workbench/ApprovalPanel";
import { TaskPanel } from "./features/workbench/TaskPanel";
import { ToolPanel } from "./features/workbench/ToolPanel";
import { WorkspaceSidebar } from "./features/workbench/WorkspaceSidebar";
import { useDesktopSessions } from "./hooks/useDesktopSessions";
import { useRunActivity } from "./hooks/useRunActivity";

type DrawerTab = "任务" | "审批" | "工具" | "产物";
type ModalState =
  | { type: "session"; title: string }
  | { type: "workspace"; projectId: string; projectName: string; name: string; rootPath: string }
  | null;

const LIVE_RUN_STATUSES = new Set<DesktopRun["status"]>(["pending", "running", "paused", "needs_approval", "waiting_user", "verifying"]);

function runLabel(status?: DesktopRun["status"]): string {
  const labels: Record<DesktopRun["status"], string> = {
    pending: "准备中",
    running: "运行中",
    paused: "已暂停",
    waiting_user: "等待输入",
    blocked: "已阻塞",
    verifying: "验证中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    needs_approval: "等待确认",
  };
  return status ? labels[status] : "就绪";
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="wb-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="wb-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
        {children}
      </section>
    </div>
  );
}

function HostRequired() {
  return (
    <main className="wb-host-required">
      <div className="wb-logo"><Planet size={17} weight="fill" /></div>
      <h1>请从拾光 Agent 桌面端打开</h1>
      <p>{getDesktopBridgeErrorMessage()}</p>
      <code>npm run desktop:dev</code>
    </main>
  );
}

export default function WorkbenchApp() {
  const bridge = getDesktopBridge();
  const {
    projects,
    workspaces,
    activeWorkspaceId,
    sessions,
    activeSessionId,
    detail,
    workspaceSnapshot,
    activeRunId,
    setActiveRunId,
    loading,
    sessionError,
    detailError,
    createProject,
    createWorkspace,
    createSession,
    branchSession,
    updateSessionStatus,
    selectSession,
    selectWorkspace,
    refreshSessions,
    refreshDetail,
  } = useDesktopSessions();
  const { events, eventsError, streamState } = useRunActivity(activeRunId);

  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState<"" | "pause" | "cancel" | "retry" | "branch">("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [decisionState, setDecisionState] = useState<Record<string, ApprovalDecisionState>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("任务");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<SettingsDrawerMode>("full");
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const activeProject = projects.find((project) => project.id === activeWorkspace?.projectId) ?? null;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeRun = detail?.runs.find((run) => run.id === activeRunId) ?? null;
  const pendingApprovals = workspaceSnapshot?.pendingApprovals ?? [];
  const artifacts = workspaceSnapshot?.artifacts ?? [];
  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => `${session.title} ${session.summary ?? ""}`.toLowerCase().includes(needle));
  }, [query, sessions]);
  const toolEvents = useMemo(() => events.filter((event) => event.kind === "tool_call" || event.kind === "tool_result"), [events]);
  const live = Boolean(activeRun && LIVE_RUN_STATUSES.has(activeRun.status));
  const waitingApproval = activeRun?.status === "needs_approval" || pendingApprovals.some((approval) => approval.status === "pending");
  const provider = detail?.session.llm?.provider || settings?.llm.provider || "未设置";
  const model = detail?.session.llm?.model || settings?.llm.model || settings?.providers[provider]?.model || "未设置";

  useEffect(() => {
    if (!bridge) return;
    void bridge.getSettings().then(setSettings).catch((error) => setActionError(`读取设置失败：${error instanceof Error ? error.message : String(error)}`));
  }, [bridge]);

  useEffect(() => {
    setInput("");
    setAttachments([]);
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId || events.length === 0) return;
    const latest = events[events.length - 1];
    if (!latest || !["message", "error", "approval_request", "approval_granted", "approval_denied", "tool_result", "system"].includes(latest.kind)) return;
    const timer = window.setTimeout(() => { void refreshDetail(); void refreshSessions(); }, 180);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, events, refreshDetail, refreshSessions]);

  const openSettings = async (mode: SettingsDrawerMode = "full") => {
    setSettingsMode(mode);
    setSettingsOpen(true);
    try { setSettings(await requireDesktopBridge().getSettings()); }
    catch (error) { setActionError(`打开设置失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const submitMessage = async () => {
    if (!activeSessionId || sending || waitingApproval) return;
    if (live && activeRun?.status !== "paused" && !input.trim() && attachments.length === 0) {
      setActionBusy("pause");
      try { await requireDesktopBridge().pauseRun({ runId: activeRun!.id }); await refreshDetail(); }
      catch (error) { setActionError(`暂停失败：${error instanceof Error ? error.message : String(error)}`); }
      finally { setActionBusy(""); }
      return;
    }
    if (!input.trim() && attachments.length === 0 && activeRun?.status !== "paused") return;
    setSending(true);
    try {
      let message = input.trim();
      if (activeRun?.status === "running" || activeRun?.status === "pending" || activeRun?.status === "verifying") {
        await requireDesktopBridge().pauseRun({ runId: activeRun.id });
        message = `${message || "请结合当前进度继续。"}\n\n请从刚暂停的运行继续，不要重复已完成的工作。上一轮 run：${activeRun.id}`;
      } else if (activeRun?.status === "paused") {
        message = `${message || "继续上次暂停的任务。"}\n\n请沿着已暂停的运行继续，并先检查最近工具结果和工作区状态。上一轮 run：${activeRun.id}`;
      }
      const run = await requireDesktopBridge().sendUserMessage({ sessionId: activeSessionId, message, attachments });
      setActiveRunId(run.id);
      setInput("");
      setAttachments([]);
      setActionError(null);
      await Promise.all([refreshDetail(), refreshSessions()]);
    } catch (error) {
      setActionError(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  };

  const decideApproval = async (approvalId: string, decision: "granted" | "denied", scope: "once" | "task" | "workspace" = "once") => {
    if (decisionState[approvalId] === "approving") return;
    setDecisionState((state) => ({ ...state, [approvalId]: "approving" }));
    try {
      await requireDesktopBridge().decideApproval({ approvalId, decision, scope });
      setDecisionState((state) => ({ ...state, [approvalId]: decision === "granted" ? "approved" : "denied" }));
      await Promise.all([refreshDetail(), refreshSessions()]);
    } catch (error) {
      setDecisionState((state) => { const next = { ...state }; delete next[approvalId]; return next; });
      setActionError(`确认操作失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runAction = async (kind: "cancel" | "retry" | "branch") => {
    if (!activeRun || actionBusy) return;
    setActionBusy(kind);
    try {
      if (kind === "cancel") await requireDesktopBridge().cancelRun({ runId: activeRun.id });
      if (kind === "retry") setActiveRunId((await requireDesktopBridge().retryRun({ runId: activeRun.id })).id);
      if (kind === "branch") {
        const result = await branchSession(activeRun.id);
        setInput(result.suggestedPrompt);
      }
      await Promise.all([refreshDetail(), refreshSessions()]);
    } catch (error) {
      setActionError(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setActionBusy(""); }
  };

  const pickAttachments = async () => {
    try {
      const picked = await requireDesktopBridge().pickAttachments();
      setAttachments((current) => [...new Map([...current, ...picked].map((item) => [item.path, item])).values()]);
    } catch (error) { setActionError(`选择附件失败：${error instanceof Error ? error.message : String(error)}`); }
  };

  const createSessionFromModal = async () => {
    if (!modal || modal.type !== "session" || !activeWorkspaceId) return;
    setModalBusy(true);
    try { await createSession(modal.title.trim() || "新任务", activeWorkspaceId); setModal(null); }
    catch (error) { setActionError(`创建任务失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setModalBusy(false); }
  };

  const createWorkspaceFromModal = async () => {
    if (!modal || modal.type !== "workspace") return;
    setModalBusy(true);
    try {
      const projectId = modal.projectName.trim() ? (await createProject(modal.projectName.trim())).id : modal.projectId;
      if (!projectId || !modal.name.trim() || !modal.rootPath.trim()) throw new Error("请填写项目、工作区名称和目录。");
      await createWorkspace({ projectId, name: modal.name.trim(), rootPath: modal.rootPath.trim() });
      setModal(null);
    } catch (error) { setActionError(`创建工作区失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setModalBusy(false); }
  };

  if (!bridge) return <HostRequired />;
  if (loading) return <div className="wb-loading"><SpinnerGap size={22} className="spin" /><span>{sessionError ?? "正在加载工作台"}</span></div>;

  const drawerPanels: Record<DrawerTab, React.ReactNode> = {
    "任务": <TaskPanel heading={activeSession?.title ?? "任务"} evidence={activeRun?.summary ?? "运行过程中形成的证据会显示在这里。"} steps={(activeRun?.checkpoints ?? []).map((item) => ({ id: item.id, label: item.title, status: item.kind }))} />,
    "审批": <ApprovalPanel approvals={pendingApprovals.map((item) => ({ id: item.id, title: item.capability }))} onDecision={(id, decision, scope) => { void decideApproval(id, decision, scope); }} />,
    "工具": <ToolPanel events={toolEvents.map((event) => ({ id: event.id, label: String((event.payload as Record<string, unknown>).tool ?? "工具"), detail: event.kind === "tool_result" ? "已返回" : "执行中" }))} />,
    "产物": <ArtifactPanel artifacts={artifacts.map((item) => ({ id: item.id, title: item.title ?? item.kind, uri: item.uri }))} onOpen={(uri) => { void requireDesktopBridge().openArtifact({ uri }); }} />,
  };

  return (
    <div className={`wb-shell${drawerOpen ? " drawer-open" : ""}`}>
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSaved={setSettings}
        mode={settingsMode}
        activeSessionId={activeSessionId}
        currentSessionWorkspaceRoot={detail?.session.workspaceRoot ?? null}
        currentSessionLlm={detail?.session.llm ?? activeSession?.llm ?? null}
        onSessionWorkspaceChanged={async () => { await Promise.all([refreshSessions(), refreshDetail()]); }}
        onSessionLlmChanged={async () => { await Promise.all([refreshSessions(), refreshDetail()]); }}
      />

      {modal?.type === "session" ? (
        <Modal title="新建任务" onClose={() => setModal(null)}>
          <label className="wb-field"><span>任务名称</span><input autoFocus value={modal.title} onChange={(event) => setModal({ ...modal, title: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void createSessionFromModal(); }} /></label>
          <p className="wb-modal-note">任务会严格创建在“{activeWorkspace?.name}”工作区中。</p>
          <footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="primary" type="button" disabled={modalBusy} onClick={() => { void createSessionFromModal(); }}>{modalBusy ? "创建中" : "创建任务"}</button></footer>
        </Modal>
      ) : null}
      {modal?.type === "workspace" ? (
        <Modal title="添加工作区" onClose={() => setModal(null)}>
          <div className="wb-form-grid">
            <label className="wb-field"><span>现有项目</span><select value={modal.projectId} onChange={(event) => setModal({ ...modal, projectId: event.target.value, projectName: "" })}><option value="">选择项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
            <label className="wb-field"><span>或新建项目</span><input value={modal.projectName} onChange={(event) => setModal({ ...modal, projectName: event.target.value })} placeholder="项目名称" /></label>
            <label className="wb-field"><span>工作区名称</span><input value={modal.name} onChange={(event) => setModal({ ...modal, name: event.target.value })} placeholder="例如：主工作区" /></label>
            <label className="wb-field"><span>本地目录</span><input value={modal.rootPath} onChange={(event) => setModal({ ...modal, rootPath: event.target.value })} placeholder="G:\\projects\\my-project" /></label>
          </div>
          <footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="primary" type="button" disabled={modalBusy} onClick={() => { void createWorkspaceFromModal(); }}>{modalBusy ? "添加中" : "添加工作区"}</button></footer>
        </Modal>
      ) : null}

      <aside className="wb-sidebar">
        <header className="wb-brand"><div className="wb-logo"><Planet size={16} weight="fill" /></div><strong>拾光</strong></header>
        <div className="wb-sidebar-heading">
          <span>工作区与任务</span>
          <div>
            <button type="button" aria-label="搜索任务" className={searchOpen ? "active" : ""} onClick={() => setSearchOpen((value) => !value)}><MagnifyingGlass size={15} /></button>
            <button type="button" aria-label="添加工作区" onClick={() => setModal({ type: "workspace", projectId: activeProject?.id ?? projects[0]?.id ?? "", projectName: "", name: "", rootPath: "" })}><FolderSimple size={15} /></button>
            <button type="button" aria-label="新建任务" disabled={!activeWorkspaceId} onClick={() => setModal({ type: "session", title: "新任务" })}><Plus size={16} /></button>
          </div>
        </div>
        {searchOpen ? <label className="wb-search"><MagnifyingGlass size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" /></label> : null}
        <div className="wb-tree">
          <WorkspaceSidebar
            projects={projects}
            workspaces={workspaces}
            sessions={filteredSessions}
            activeWorkspaceId={activeWorkspaceId}
            activeSessionId={activeSessionId}
            onSelectWorkspace={selectWorkspace}
            onSelectSession={selectSession}
            emptyWorkspaceAction={(workspaceId) => <button className="wb-new-task-inline" type="button" onClick={() => { selectWorkspace(workspaceId); setModal({ type: "session", title: "新任务" }); }}><Plus size={14} />新建任务</button>}
            renderSession={(session) => (
              <button className={`workspace-session-link${session.id === activeSessionId ? " active" : ""}`} aria-current={session.id === activeSessionId ? "page" : undefined} key={session.id} type="button" onClick={() => selectSession(session.id)}>
                <ChatCircle size={15} weight={session.id === activeSessionId ? "fill" : "regular"} /><span>{session.title}</span><small>{session.status === "archived" ? "已归档" : ""}</small>
              </button>
            )}
          />
        </div>
        <footer className="wb-sidebar-footer"><span className={streamState === "live" ? "connected" : ""}><i />{streamState === "live" ? "已连接" : "本地"}</span><button type="button" aria-label="设置" onClick={() => { void openSettings(); }}><GearSix size={17} /></button></footer>
      </aside>

      <main className="wb-main">
        <header className="wb-topbar">
          <div className="wb-title"><strong>{activeSession?.title ?? activeWorkspace?.name ?? "工作台"}</strong><span>{activeWorkspace?.name ?? activeProject?.name ?? "未选择工作区"}</span></div>
          <div className="wb-top-actions">
            {activeRun ? <span className={`wb-top-status ${activeRun.status}`}><i />{runLabel(activeRun.status)}</span> : null}
            <button type="button" className={`wb-icon-action${drawerOpen ? " active" : ""}`} aria-label="上下文" title="上下文" onClick={() => setDrawerOpen((value) => !value)}><SidebarSimple size={17} /></button>
            <div className="wb-more">
              <button type="button" className={`wb-icon-action${moreOpen ? " active" : ""}`} aria-label="更多操作" title="更多操作" onClick={() => setMoreOpen((value) => !value)}><DotsThree size={19} weight="bold" /></button>
              {moreOpen ? <div className="wb-more-menu">
                {activeRun ? <button type="button" onClick={() => { setMoreOpen(false); void runAction("retry"); }} disabled={Boolean(actionBusy)}><SpinnerGap size={15} />重试任务</button> : null}
                {activeRun ? <button type="button" onClick={() => { setMoreOpen(false); void runAction("branch"); }} disabled={Boolean(actionBusy)}><GitBranch size={15} />从此分支</button> : null}
                {activeSession ? <button type="button" onClick={() => { setMoreOpen(false); void updateSessionStatus(activeSession.id, activeSession.status === "archived" ? "active" : "archived"); }}><Archive size={15} />{activeSession.status === "archived" ? "恢复任务" : "归档任务"}</button> : null}
                <button type="button" onClick={() => { setMoreOpen(false); void openSettings(); }}><GearSix size={15} />设置</button>
              </div> : null}
            </div>
          </div>
        </header>

        {activeRun && (live || activeRun.status === "failed" || activeRun.status === "blocked") ? <section className={`wb-live-strip ${activeRun.status}`}><span>{activeRun.reason || activeRun.summary || runLabel(activeRun.status)}</span>{pendingApprovals.length > 0 ? <button type="button" onClick={() => { setDrawerTab("审批"); setDrawerOpen(true); }}>{pendingApprovals.length} 个操作待确认</button> : null}</section> : null}

        {(sessionError || detailError || eventsError || actionError) ? <div className="wb-error-banner"><strong>需要处理</strong><span>{actionError || eventsError || detailError || sessionError}</span><button type="button" aria-label="关闭错误" onClick={() => setActionError(null)}><X size={14} /></button></div> : null}

        {!activeSession ? (
          <section className="wb-empty">
            <div className="wb-empty-mark"><ChatCircle size={26} /></div>
            <span>当前工作区</span>
            <h1>{activeWorkspace ? "从一个新任务开始" : "先添加一个工作区"}</h1>
            <p>{activeWorkspace ? "任务会绑定当前目录，读取、修改、审批和产物都不会跑到其他工作区。" : "工作区决定 Agent 可以修改的代码范围。"}</p>
            <button type="button" className="primary" onClick={() => activeWorkspaceId ? setModal({ type: "session", title: "新任务" }) : setModal({ type: "workspace", projectId: projects[0]?.id ?? "", projectName: "", name: "", rootPath: "" })}><Plus size={16} />{activeWorkspaceId ? "新建任务" : "添加工作区"}</button>
          </section>
        ) : (
          <>
            <section className="wb-conversation">
              <ActivityFeed entries={detail?.conversation ?? []} events={events} approvals={pendingApprovals} decisionState={decisionState} onApprovalDecision={decideApproval} />
            </section>
            <section className="wb-composer-wrap">
              <div className="wb-composer">
                <textarea ref={textareaRef} value={input} disabled={sending || Boolean(actionBusy)} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submitMessage(); } }} placeholder={activeRun?.status === "paused" ? "补充要求，或直接继续上次任务…" : live ? "运行中也可以补充要求…" : "输入任务、问题或命令…"} />
                {attachments.length > 0 ? <div className="wb-attachments">{attachments.map((item) => <span key={item.path}><File size={14} />{item.name}<button type="button" aria-label={`移除 ${item.name}`} onClick={() => setAttachments((items) => items.filter((candidate) => candidate.path !== item.path))}><X size={12} /></button></span>)}</div> : null}
                <footer>
                  <div><button type="button" title="添加附件" aria-label="添加附件" disabled={live && activeRun?.status !== "paused"} onClick={() => { void pickAttachments(); }}><Paperclip size={17} /></button><button type="button" onClick={() => { void openSettings("model"); }}>{provider} · {model}</button></div>
                  <div>{live && activeRun?.status !== "paused" ? <button type="button" className="stop" title="取消运行" aria-label="取消运行" onClick={() => { void runAction("cancel"); }}><Stop size={15} weight="fill" /></button> : null}<button type="button" className="send" aria-label={live && !input.trim() ? "暂停" : "发送"} disabled={sending || Boolean(actionBusy) || waitingApproval || (!live && !input.trim() && attachments.length === 0 && activeRun?.status !== "paused")} onClick={() => { void submitMessage(); }}>{sending ? <SpinnerGap size={18} className="spin" /> : live && !input.trim() ? <Pause size={18} weight="fill" /> : <PaperPlaneRight size={18} weight="fill" />}</button></div>
                </footer>
              </div>
            </section>
          </>
        )}
      </main>

      {drawerOpen ? (
        <aside className="wb-drawer">
          <header><div><span>当前任务</span><h2>{activeSession?.title ?? "上下文"}</h2></div><button type="button" aria-label="关闭上下文" onClick={() => setDrawerOpen(false)}><X size={17} /></button></header>
          <nav>{(["任务", "审批", "工具", "产物"] as DrawerTab[]).map((tab) => { const Icon = tab === "任务" ? Checks : tab === "审批" ? Brain : tab === "工具" ? Wrench : File; const count = tab === "审批" ? pendingApprovals.length : tab === "工具" ? toolEvents.length : tab === "产物" ? artifacts.length : activeRun?.checkpoints?.length ?? 0; return <button type="button" key={tab} className={drawerTab === tab ? "active" : ""} onClick={() => setDrawerTab(tab)}><Icon size={15} />{tab}{count > 0 ? <span>{count}</span> : null}</button>; })}</nav>
          <div className="wb-drawer-body">{drawerPanels[drawerTab]}</div>
        </aside>
      ) : null}
    </div>
  );
}

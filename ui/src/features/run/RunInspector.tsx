import type { DesktopApproval, DesktopArtifact, DesktopEvent, DesktopRun } from "../../bridge";
import { ArtifactCard } from "../artifacts/ArtifactCard";
import "./run-inspector.css";

type FailureSummary = { title: string; summary: string; cause: string; nextStep: string };

function statusLabel(status: DesktopRun["status"]): string {
  const labels: Record<DesktopRun["status"], string> = {
    waiting_user: "等待你的输入",
    blocked: "已阻塞",
    verifying: "正在验证",
    pending: "等待中",
    running: "运行中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    needs_approval: "等待确认",
  };
  return labels[status];
}

export function RunInspector({
  open, onClose, activeRun, runs, events, approvals, artifacts, failure,
  onSelectRun, onRetry, onBranch, onDraftRepair, onCopyArtifact, onOpenArtifact, onRevealArtifact,
}: {
  open: boolean;
  onClose: () => void;
  activeRun: DesktopRun | null;
  runs: DesktopRun[];
  events: DesktopEvent[];
  approvals: DesktopApproval[];
  artifacts: DesktopArtifact[];
  failure: FailureSummary | null;
  onSelectRun: (runId: string) => void;
  onRetry: (runId: string) => void;
  onBranch: (run: DesktopRun) => void;
  onDraftRepair: () => void;
  onCopyArtifact: (uri: string) => void;
  onOpenArtifact: (uri: string) => void;
  onRevealArtifact: (uri: string) => void;
}) {
  if (!open) return null;
  const counts = events.reduce<Record<string, number>>((all, event) => ({ ...all, [event.kind]: (all[event.kind] ?? 0) + 1 }), {});
  return (
    <aside className="run-inspector" aria-label="运行检查器">
      <header className="run-inspector-head"><div><span>Inspector</span><h3>运行检查器</h3></div><button type="button" onClick={onClose} aria-label="关闭运行检查器">×</button></header>
      <div className="run-inspector-scroll">
        <section className="inspector-section">
          <div className="inspector-title"><h4>当前运行</h4><strong>{activeRun ? statusLabel(activeRun.status) : "空闲"}</strong></div>
          {activeRun ? <dl className="inspector-facts"><div><dt>ID</dt><dd>{activeRun.id.slice(0, 12)}</dd></div><div><dt>开始</dt><dd>{activeRun.startedAt ? new Date(activeRun.startedAt).toLocaleString() : "—"}</dd></div><div><dt>事件</dt><dd>{events.length}</dd></div><div><dt>待确认</dt><dd>{approvals.length}</dd></div></dl> : <p>选择一次运行查看详情。</p>}
          {activeRun?.budget ? <p className="inspector-reason">步骤预算：{activeRun.budget.stepsUsed} / {activeRun.budget.maxSteps}</p> : null}
          {activeRun?.reason ? <p className="inspector-reason">{activeRun.reason}</p> : null}
        </section>

        <section className="inspector-section">
          <div className="inspector-title"><h4>任务检查点</h4><span>{activeRun?.checkpoints?.length ?? 0}</span></div>
          {activeRun?.checkpoints?.length ? <ol className="inspector-run-list">{activeRun.checkpoints.map((checkpoint) => <li key={checkpoint.id}><strong>{checkpoint.title}</strong><span>{checkpoint.summary || checkpoint.kind}</span></li>)}</ol> : <p>此运行尚未写入检查点。</p>}
        </section>

        {failure ? <section className="inspector-section failure"><div className="inspector-title"><h4>{failure.title}</h4><strong>需要处理</strong></div><p>{failure.summary}</p><p><b>原因：</b>{failure.cause}</p><p><b>下一步：</b>{failure.nextStep}</p><div className="inspector-card-actions"><button type="button" onClick={onDraftRepair}>写入修复提示</button>{activeRun ? <><button type="button" onClick={() => onBranch(activeRun)}>分支修复</button><button type="button" onClick={() => onRetry(activeRun.id)}>重新运行</button></> : null}</div></section> : null}

        <section className="inspector-section"><div className="inspector-title"><h4>事件分布</h4><span>{events.length}</span></div><div className="event-count-grid">{Object.entries(counts).length ? Object.entries(counts).map(([kind, count]) => <div key={kind}><span>{kind}</span><strong>{count}</strong></div>) : <p>暂无事件</p>}</div></section>

        <section className="inspector-section"><div className="inspector-title"><h4>运行历史</h4><span>{runs.length}</span></div><div className="inspector-run-list">{runs.map((run) => <article className={run.id === activeRun?.id ? "active" : ""} key={run.id}><button type="button" onClick={() => onSelectRun(run.id)}><span>{statusLabel(run.status)}</span><strong>{run.summary || run.reason || run.id.slice(0, 10)}</strong></button><div><button type="button" onClick={() => onBranch(run)}>分支</button><button type="button" onClick={() => onRetry(run.id)}>重试</button></div></article>)}</div></section>

        <section className="inspector-section"><div className="inspector-title"><h4>运行产物</h4><span>{artifacts.length}</span></div>{artifacts.length ? <div className="inspector-artifact-list">{artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onSelectRun={onSelectRun} onCopy={onCopyArtifact} onOpen={onOpenArtifact} onReveal={onRevealArtifact} />)}</div> : <p>当前运行还没有产物。</p>}</section>
      </div>
    </aside>
  );
}

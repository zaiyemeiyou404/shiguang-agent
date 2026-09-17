import type { DesktopApproval } from "../../bridge";
import { normalizeApproval } from "./approval-model";
import "./approvals.css";

export type ApprovalDecisionState = "approving" | "approved" | "denied";

export function ApprovalCard({
  approval,
  decisionState,
  onDecision,
}: {
  approval: DesktopApproval;
  decisionState?: ApprovalDecisionState;
  onDecision: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  const view = normalizeApproval(approval);
  const pending = approval.status === "pending" && !decisionState;
  const busy = decisionState === "approving";
  const status = decisionState === "approving"
    ? "处理中"
    : decisionState === "approved" || approval.status === "granted"
      ? "已允许"
      : decisionState === "denied" || approval.status === "denied"
        ? "已拒绝"
        : approval.status === "expired"
          ? "已过期"
          : "等待确认";

  return (
    <article className="approval-card" aria-label={`${view.title}，${status}`}>
      <header className="approval-card-head">
        <div>
          <span className="approval-eyebrow">操作确认</span>
          <h4>{view.title}</h4>
        </div>
        <span className={`approval-state ${pending || busy ? "pending" : approval.status === "granted" || decisionState === "approved" ? "allowed" : "closed"}`}>{status}</span>
      </header>

      <p className="approval-summary">{view.summary}</p>
      <dl className="approval-facts">
        <div><dt>能力</dt><dd>{view.capability}</dd></div>
        {view.toolName ? <div><dt>工具</dt><dd>{view.toolName}</dd></div> : null}
        {view.target ? <div><dt>目标</dt><dd>{view.target}</dd></div> : null}
        {view.workingDirectory ? <div><dt>工作目录</dt><dd>{view.workingDirectory}</dd></div> : null}
        {view.operation ? <div><dt>操作</dt><dd>{view.operation}</dd></div> : null}
      </dl>

      {view.warnings.length > 0 ? (
        <div className="approval-warnings" role="note">
          {view.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
        </div>
      ) : null}
      {view.additions !== null || view.deletions !== null ? (
        <p className="approval-diff-stat"><span>+{view.additions ?? 0}</span><span>−{view.deletions ?? 0}</span>{view.truncated ? <em>预览已截断</em> : null}</p>
      ) : null}
      {view.diff ? <pre className="approval-diff">{view.diff}</pre> : null}
      <details className="approval-details">
        <summary>查看完整参数</summary>
        <pre>{view.rawText || "{}"}</pre>
      </details>

      {approval.status === "pending" ? (
        <footer className="approval-actions">
          <button type="button" disabled={busy || Boolean(decisionState)} onClick={() => onDecision(approval.id, "denied")}>拒绝</button>
          <button className="primary" type="button" disabled={busy || Boolean(decisionState)} onClick={() => onDecision(approval.id, "granted")}>
            {busy ? "处理中…" : "允许一次"}
          </button>
        </footer>
      ) : null}
    </article>
  );
}

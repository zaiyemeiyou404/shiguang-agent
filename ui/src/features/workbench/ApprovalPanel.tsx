type ApprovalPanelProps = {
  approvals: { id: string; title: string }[];
  onDecision: (approvalId: string, decision: "granted" | "denied", scope: "once") => void;
};

export function ApprovalPanel({ approvals, onDecision }: ApprovalPanelProps) {
  return <section className="approval-panel">
    <h2>审批</h2>
    {approvals.length === 0 ? <p className="muted">当前没有待审批操作。</p> : approvals.map((approval) => (
      <article className="approval-panel-item" key={approval.id}>
        <strong>{approval.title}</strong>
        <div>
          <button className="tool-btn" onClick={() => onDecision(approval.id, "granted", "once")} type="button">允许一次</button>
          <button className="tool-btn" onClick={() => onDecision(approval.id, "denied", "once")} type="button">拒绝</button>
        </div>
      </article>
    ))}
  </section>;
}

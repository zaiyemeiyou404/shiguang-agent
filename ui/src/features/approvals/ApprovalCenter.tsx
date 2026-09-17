import type { DesktopApproval } from "../../bridge";
import { ApprovalCard, type ApprovalDecisionState } from "./ApprovalCard";

export function ApprovalCenter({
  approvals,
  decisionState,
  onDecision,
}: {
  approvals: DesktopApproval[];
  decisionState: Record<string, ApprovalDecisionState>;
  onDecision: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  return (
    <section className="approval-center">
      <header>
        <div><span>Review</span><h3>操作确认</h3><p>所有需要你决定的高风险动作集中在这里。</p></div>
        <strong>{approvals.length}</strong>
      </header>
      {approvals.length === 0
        ? <div className="approval-center-empty"><h4>当前没有待确认操作</h4><p>文件修改、终端命令或发布动作需要确认时会出现在这里。</p></div>
        : <div className="approval-center-list">{approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} decisionState={decisionState[approval.id]} onDecision={onDecision} />)}</div>}
    </section>
  );
}

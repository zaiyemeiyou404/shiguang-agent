import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopApproval, DesktopConversationEntry, DesktopEvent } from "../../bridge";
import { ApprovalCard, type ApprovalDecisionState } from "../approvals/ApprovalCard";
import { buildActivityItems } from "./activity-model";
import "./activity.css";

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "暂无内容";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ActivityFeed({
  entries,
  events,
  approvals = [],
  decisionState = {},
  onApprovalDecision,
}: {
  entries: DesktopConversationEntry[];
  events: DesktopEvent[];
  approvals?: DesktopApproval[];
  decisionState?: Record<string, ApprovalDecisionState>;
  onApprovalDecision?: (approvalId: string, decision: "granted" | "denied") => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const items = useMemo(() => buildActivityItems(entries, events), [entries, events]);
  const referencedApprovalIds = new Set(items.filter((item) => item.type === "approval").map((item) => item.approvalId).filter(Boolean));
  const unmatchedApprovals = approvals.filter((approval) => !referencedApprovalIds.has(approval.id));

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !following) return;
    host.scrollTo({ top: host.scrollHeight, behavior: "smooth" });
  }, [following, items.length, approvals.length]);

  if (items.length === 0 && approvals.length === 0) {
    return <div className="activity-feed empty"><p>还没有聊天内容，发一条消息就会开始。</p></div>;
  }

  const decide = onApprovalDecision ?? (() => {});
  return (
    <div
      className="activity-feed"
      ref={hostRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 72);
      }}
    >
      {unmatchedApprovals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} decisionState={decisionState[approval.id]} onDecision={decide} />
      ))}
      {items.map((item) => {
        if (item.type === "response") {
          return (
            <article key={item.id} className={`activity-card response-card ${item.role}`}>
              <header><span>{item.from}</span><time>{formatTime(item.createdAt)}</time></header>
              <p>{item.content}</p>
            </article>
          );
        }
        if (item.type === "thinking") {
          return <details key={item.id} className="activity-card thinking-card"><summary>思考过程 <time>{formatTime(item.createdAt)}</time></summary><p>{item.content}</p></details>;
        }
        if (item.type === "tool") {
          return (
            <details key={item.id} className={`activity-card tool-activity ${item.status}`} open={item.status === "error" || item.status === "orphan-result"}>
              <summary><span className="tool-status-dot" />{item.tool}<em>{item.status === "running" ? "运行中" : item.status === "success" ? "已完成" : item.status === "error" ? "失败" : "仅有结果"}</em><time>{formatTime(item.createdAt)}</time></summary>
              <div className="tool-columns">
                <section><h5>调用参数</h5><pre>{pretty(item.input)}</pre></section>
                <section><h5>执行结果</h5><pre>{pretty(item.output)}</pre></section>
              </div>
            </details>
          );
        }
        if (item.type === "approval") {
          const approval = approvals.find((candidate) => candidate.id === item.approvalId);
          return approval
            ? <ApprovalCard key={item.id} approval={approval} decisionState={decisionState[approval.id]} onDecision={decide} />
            : <article key={item.id} className="activity-card notice-card warning"><header><span>操作确认</span><time>{formatTime(item.createdAt)}</time></header><p>运行正在等待 {item.capability} 权限确认。</p></article>;
        }
        return (
          <article key={item.id} className={`activity-card notice-card ${item.type}`}>
            <header><span>{item.type === "error" ? "运行错误" : item.type === "context" ? "上下文压缩" : "系统"}</span><time>{formatTime(item.createdAt)}</time></header>
            <p>{item.message}</p>
            {item.code ? <code>{item.code}</code> : null}
          </article>
        );
      })}
      {!following ? <button className="jump-latest" type="button" onClick={() => { setFollowing(true); hostRef.current?.scrollTo({ top: hostRef.current.scrollHeight, behavior: "smooth" }); }}>回到最新</button> : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopApproval, DesktopConversationEntry, DesktopEvent } from "../../bridge";
import { ApprovalCard, type ApprovalDecisionState } from "../approvals/ApprovalCard";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import { buildActivityItems, campusCardUrl } from "./activity-model";

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CampusCardFrame({ url }: { url: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(360);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { jsonrpc?: string; method?: string; params?: { height?: number } } | null;
      if (!data || data.jsonrpc !== "2.0" || data.method !== "ui/notifications/size-changed") return;
      const next = Number(data.params?.height);
      if (Number.isFinite(next) && next > 40 && next < 4000) setHeight(Math.ceil(next + 8));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url]);
  return <iframe ref={frameRef} className="campus-card-frame" title="校园卡片" src={url} style={{ height }} />;
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
  running = false,
  onApprovalDecision,
}: {
  entries: DesktopConversationEntry[];
  events: DesktopEvent[];
  approvals?: DesktopApproval[];
  decisionState?: Record<string, ApprovalDecisionState>;
  running?: boolean;
  onApprovalDecision?: (approvalId: string, decision: "granted" | "denied", scope?: "once" | "task" | "workspace") => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const items = useMemo(() => buildActivityItems(entries, events), [entries, events]);
  const processItems = items.filter((item) => item.type === "thinking" || item.type === "tool");
  const firstProcessId = processItems[0]?.id;
  const processSteps = processItems.reduce((count, item) => count + (item.type === "thinking" ? item.steps.length : 0), 0);
  const processTools = processItems.filter((item) => item.type === "tool").length;
  const processHasError = processItems.some((item) => item.type === "tool" && (item.status === "error" || item.status === "orphan-result"));
  const campusCardUrls = processItems.flatMap((item) => {
    if (item.type !== "tool") return [];
    const url = campusCardUrl(item.output);
    return url ? [url] : [];
  });
  const activeCardUrl = campusCardUrls[campusCardUrls.length - 1] ?? null;
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
    <div className={`activity-layout${activeCardUrl ? " has-card" : ""}`}>
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
              <MarkdownMessage content={item.content} />
            </article>
          );
        }
        if (item.type === "thinking" || item.type === "tool") {
          if (item.id !== firstProcessId) return null;
          return (
            <details key={item.id} className={`activity-card process-card${processHasError ? " error" : ""}${running ? " running" : ""}`} open={processHasError || Boolean(activeCardUrl) || running}>
              <summary><span className="process-dot" /><strong>{running ? "运行中" : `工作过程${processSteps > 0 ? ` · ${processSteps} 步` : ""}`}</strong>{running ? <em>正在处理，回复会显示在下方</em> : processTools > 0 ? <em>{processTools} 个工具</em> : null}<time>{formatTime(item.createdAt)}</time></summary>
              <div className="process-body">
                {processItems.map((processItem) => processItem.type === "thinking" ? (
                  <div className="process-thoughts" key={processItem.id}>{processItem.steps.map((step, index) => <p key={`${processItem.id}:${index}`}>{step}</p>)}</div>
                ) : (
                  <section className={`process-tool ${processItem.status}`} key={processItem.id}>
                    <header><span className="tool-status-dot" /><strong>{processItem.tool}</strong><em>{processItem.status === "running" ? "运行中" : processItem.status === "success" ? "已完成" : processItem.status === "error" ? "失败" : "仅有结果"}</em></header>
                    <div className="tool-columns">
                      <section><h5>调用参数</h5><pre>{pretty(processItem.input)}</pre></section>
                      <section><h5>执行结果</h5>{campusCardUrl(processItem.output) ? <p className="muted">卡片已在右侧展开。</p> : <pre>{pretty(processItem.output)}</pre>}</section>
                    </div>
                  </section>
                ))}
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
    {activeCardUrl ? <aside className="campus-card-pane"><CampusCardFrame url={activeCardUrl} /></aside> : null}
    </div>
  );
}

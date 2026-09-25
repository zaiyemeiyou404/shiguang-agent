import { useState } from "react";

type MemoryItem = { id: string; summary: string; status: "active" | "stale" };
type CandidateItem = { id: string; summary: string };

export function MemoryPanel({ candidates, memories, onAccept, onDismiss, onMarkStale, onForget }: {
  candidates: CandidateItem[];
  memories: MemoryItem[];
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onMarkStale: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"候选" | "有效" | "已失效">("有效");
  const visible = filter === "候选" ? candidates : memories.filter((memory) => memory.status === (filter === "有效" ? "active" : "stale"));
  const count = (tab: typeof filter) => tab === "候选" ? candidates.length : memories.filter((memory) => memory.status === (tab === "有效" ? "active" : "stale")).length;
  return <section className="memory-panel">
    <div role="tablist" aria-label="记忆筛选">
      {(["候选", "有效", "已失效"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={filter === tab} onClick={() => setFilter(tab)}>{tab} {count(tab)}</button>)}
    </div>
    <div className="memory-panel-list">
      {visible.map((item) => filter === "候选" ? <article key={item.id}><strong>{item.summary}</strong><div><button type="button" className="tool-btn" onClick={() => onAccept(item.id)}>保留</button><button type="button" className="tool-btn" onClick={() => onDismiss(item.id)}>忽略</button></div></article> : <article key={item.id}><strong>{item.summary}</strong><div>{filter === "有效" ? <button type="button" className="tool-btn" onClick={() => onMarkStale(item.id)}>标记失效</button> : null}<button type="button" className="tool-btn" onClick={() => onForget(item.id)}>删除</button></div></article>)}
    </div>
  </section>;
}

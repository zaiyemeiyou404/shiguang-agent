import type { ReactNode } from "react";

type ConversationPaneProps = {
  title: string;
  taskTitle: string;
  progressLabel: string;
  onOpenTaskDrawer: () => void;
  children: ReactNode;
};

export function ConversationPane({ title, taskTitle, progressLabel, onOpenTaskDrawer, children }: ConversationPaneProps) {
  return (
    <section className="conversation-pane" aria-label={title}>
      <div className="conversation-task-status" role="status">
        <div>
          <strong>{taskTitle}</strong>
          <span>{progressLabel}</span>
        </div>
        <button type="button" className="tool-btn" onClick={onOpenTaskDrawer}>任务详情</button>
      </div>
      <div className="conversation-pane-content">{children}</div>
    </section>
  );
}

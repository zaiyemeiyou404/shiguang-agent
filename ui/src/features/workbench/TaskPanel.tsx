import type { ReactNode } from "react";

type TaskPanelProps = {
  heading: string;
  evidence: string;
  steps: { id: string; label: string; status: string }[];
  controls?: ReactNode;
};

export function TaskPanel({ heading, evidence, steps, controls }: TaskPanelProps) {
  return (
    <section className="task-panel" aria-label="任务详情">
      <h2>{heading}</h2>
      <div className="task-panel-section">
        <h3>计划步骤</h3>
        {steps.length ? <ol>{steps.map((step) => <li key={step.id}><span>{step.label}</span><small>{step.status}</small></li>)}</ol> : <p className="muted">暂无计划步骤。</p>}
      </div>
      <div className="task-panel-section">
        <h3>{evidence}</h3>
      </div>
      {controls ? <div className="task-panel-controls">{controls}</div> : null}
    </section>
  );
}

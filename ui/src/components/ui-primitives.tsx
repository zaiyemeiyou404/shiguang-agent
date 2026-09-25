import type { ReactNode } from "react";

export type SignalTone = "neutral" | "success" | "warn" | "danger" | "accent";

export function ToolBtn({
  primary,
  children,
  onClick,
}: {
  primary?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return <button className={`tool-btn${primary ? " primary" : ""}`} type="button" onClick={onClick}>{children}</button>;
}

export function SignalPill({ tone, children }: { tone: SignalTone; children: ReactNode }) {
  return <span className={`signal-pill ${tone}`}>{children}</span>;
}

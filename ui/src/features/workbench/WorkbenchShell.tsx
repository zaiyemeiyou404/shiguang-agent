import { type ReactNode, useEffect, useRef, useState } from "react";

export type WorkbenchShellProps = {
  sidebar: ReactNode;
  header: ReactNode;
  statusBar: ReactNode;
  conversation: ReactNode;
  drawer: ReactNode;
};

export function WorkbenchShell({ sidebar, header, statusBar, conversation, drawer }: WorkbenchShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const closeDrawer = () => {
    setDrawerOpen(false);
    queueMicrotask(() => openerRef.current?.focus());
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drawerOpen) closeDrawer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  return <div className={`workbench-shell ${drawerOpen ? "is-drawer-open" : ""}`}>
    <aside className="workbench-sidebar">{sidebar}</aside>
    <main className="workbench-main">
      {header}
      {statusBar}
      <button className="workbench-task-trigger" type="button" onClick={(event) => { openerRef.current = event.currentTarget; setDrawerOpen(true); }}>任务详情</button>
      {conversation}
    </main>
    {drawerOpen ? <aside className="workbench-drawer" aria-label="上下文面板">{drawer}</aside> : null}
  </div>;
}

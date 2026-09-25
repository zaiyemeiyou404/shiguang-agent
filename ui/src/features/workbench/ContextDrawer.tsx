import type { ReactNode } from "react";

type ContextDrawerProps = {
  activeTab: string;
  onTabChange: (tab: string) => void;
  panels: Record<string, ReactNode>;
};

export function ContextDrawer({ activeTab, onTabChange, panels }: ContextDrawerProps) {
  const tabs = Object.keys(panels);
  const selectedTab = panels[activeTab] ? activeTab : tabs[0];
  return (
    <aside className="context-drawer" aria-label="上下文面板">
      <div className="context-drawer-tabs" role="tablist" aria-label="上下文分类">
        {tabs.map((tab) => (
          <button
            aria-selected={tab === selectedTab}
            className={tab === selectedTab ? "active" : ""}
            key={tab}
            onClick={() => onTabChange(tab)}
            role="tab"
            type="button"
          >{tab}</button>
        ))}
      </div>
      <div className="context-drawer-panel" role="tabpanel">{panels[selectedTab]}</div>
    </aside>
  );
}

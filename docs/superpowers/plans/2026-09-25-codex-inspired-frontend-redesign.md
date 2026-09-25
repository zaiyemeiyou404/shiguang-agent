# Codex-Inspired Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the desktop renderer around a chat-first workbench with a persistent workspace sidebar and an on-demand context drawer, without changing Agent, Provider, IPC, or security behavior.

**Architecture:** Split visual layout concerns from the current monolithic `ui/src/App.tsx` into an app-shell feature and context panels. Existing `Desktop*` bridge types, desktop events, approval cards, response cards, tool cards, memory APIs, and session hooks remain the data contract; the new shell only relocates their rendering and adds local drawer state.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, Electron bridge.

**Spec:** `docs/superpowers/specs/2026-09-25-codex-inspired-frontend-redesign-design.md`

## Global Constraints

- Preserve the existing Project → Workspace → Session ownership and current-workspace filtering.
- Do not change Agent loops, Provider protocols, Electron IPC method names, tool permissions, or SQLite schema for this layout work.
- Keep response cards, approval cards, tool cards, artifact interactions, memory candidate actions and existing event rendering functional.
- Keep dark theme with restrained orange-gold accent; do not reuse Codex brand assets or copy.
- Support 1366×768, 1440×900, and 1920×1080 without obscured or unreachable controls.
- `Esc` closes the context drawer and restores focus to its opener; status must have text as well as color.

## Review Focus

- An empty workspace selected in the sidebar must remain selected instead of falling back to another workspace session; cover in Task 2.
- A pending approval or running task must remain visible after moving its cards into the drawer/shell; cover in Tasks 3 and 4.
- A narrow 1366×768 window must overlay the main pane with the drawer, not shrink the workspace sidebar into unreadable content; cover in Task 3.
- A stale memory must remain auditable but not appear as active reusable memory; cover in Task 5.
- Closing a drawer by keyboard must restore focus and must not interrupt or mutate an active run; cover in Task 3.

---

## File Structure

- Create `ui/src/features/workbench/WorkbenchShell.tsx` — stable three-region layout, local drawer state and keyboard handling.
- Create `ui/src/features/workbench/WorkbenchShell.test.tsx` — drawer open/close, focus restoration and narrow-overlay behavior.
- Create `ui/src/features/workbench/WorkspaceSidebar.tsx` — project/workspace/session navigation presentation.
- Create `ui/src/features/workbench/ConversationPane.tsx` — title bar, compact task status line, existing conversation timeline and composer slots.
- Create `ui/src/features/workbench/ContextDrawer.tsx` — accessible drawer, tabs and panel slots.
- Create `ui/src/features/workbench/TaskPanel.tsx` — task plan, checkpoint, evidence and controls presentation.
- Create `ui/src/features/workbench/MemoryPanel.tsx` — candidate/active/stale views and existing memory actions.
- Modify `ui/src/App.tsx` — retain data fetching/actions but compose the new workbench components instead of owning layout markup.
- Modify `ui/src/styles.css` (or the existing global style source discovered during Task 1) — shell grid, responsive drawer, compact task bar and panel visual language.
- Modify `ui/src/bridge.ts` only if a panel needs an already-supported `Desktop*` type import; do not add IPC.

## Task 1: Extract stable shell primitives and visual tokens

**Files:**
- Create: `ui/src/features/workbench/WorkbenchShell.tsx`
- Create: `ui/src/features/workbench/WorkbenchShell.test.tsx`
- Modify: existing global UI style source discovered by `rg --files ui/src | rg "css$"`

**Interfaces:**
- Produces `WorkbenchShell({ sidebar, header, statusBar, conversation, drawer, drawerOpen, drawerLabel, onDrawerOpenChange }): JSX.Element`.
- Produces `useWorkbenchDrawer()` returning `{ open, activeTab, openerRef, openDrawer(tab, opener), closeDrawer() }`.

- [ ] **Step 1: Write the failing drawer accessibility test**

```tsx
it("closes the context drawer with Escape and restores focus to its opener", async () => {
  const user = userEvent.setup();
  render(<WorkbenchHarness />);
  const opener = screen.getByRole("button", { name: "任务详情" });
  await user.click(opener);
  expect(screen.getByRole("complementary", { name: "上下文面板" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("complementary", { name: "上下文面板" })).toBeNull();
  expect(opener).toHaveFocus();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkbenchShell.test.tsx`

Expected: FAIL because `WorkbenchShell` does not exist.

- [ ] **Step 3: Implement the minimal shell and drawer hook**

```tsx
export function WorkbenchShell(props: WorkbenchShellProps) {
  return <div className={`workbench-shell ${props.drawerOpen ? "is-drawer-open" : ""}`}>
    <aside className="workbench-sidebar">{props.sidebar}</aside>
    <main className="workbench-main">{props.header}{props.statusBar}{props.conversation}</main>
    {props.drawerOpen ? <aside aria-label="上下文面板" className="workbench-drawer">{props.drawer}</aside> : null}
  </div>;
}
```

- [ ] **Step 4: Add CSS for a fixed 304px sidebar, flexible conversation pane and 376px overlaying drawer**

```css
.workbench-shell { display:grid; grid-template-columns:304px minmax(0,1fr); min-height:100vh; }
.workbench-drawer { position:fixed; inset:0 0 0 auto; width:min(376px,calc(100vw - 304px)); }
@media (min-width: 1500px) { .workbench-shell.is-drawer-open { grid-template-columns:304px minmax(0,1fr) 376px; } .workbench-drawer { position:static; width:auto; } }
```

- [ ] **Step 5: Run focused UI tests to verify they pass**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkbenchShell.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/features/workbench ui/src/*.css
git commit -m "feat: add chat-first workbench shell"
```

## Task 2: Move project, workspace and session navigation into `WorkspaceSidebar`

**Files:**
- Create: `ui/src/features/workbench/WorkspaceSidebar.tsx`
- Create: `ui/src/features/workbench/WorkspaceSidebar.test.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes existing `projects`, `workspaces`, `sessions`, `activeWorkspaceId`, `activeSessionId`, and their existing callbacks from `App.tsx`.
- Produces `WorkspaceSidebar` with `onSelectWorkspace(workspaceId)` and `onSelectSession(sessionId)`; it owns no persistence or desktop calls.

- [ ] **Step 1: Write failing selection-boundary tests**

```tsx
it("keeps an explicitly selected empty workspace highlighted", async () => {
  render(<WorkspaceSidebar {...props} activeWorkspaceId="workspace-empty" activeSessionId={null} />);
  expect(screen.getByRole("button", { name: "空工作区" })).toHaveAttribute("aria-current", "true");
  expect(screen.queryByText("Default Session")).toBeNull();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkspaceSidebar.test.tsx`

Expected: FAIL because `WorkspaceSidebar` does not exist.

- [ ] **Step 3: Implement a presentational sidebar grouped by project and workspace**

```tsx
export function WorkspaceSidebar({ workspaces, sessions, activeWorkspaceId, activeSessionId, onSelectWorkspace, onSelectSession }: Props) {
  return <nav aria-label="项目与会话">{/* project/workspace groups; only sessions matching each workspace */}</nav>;
}
```

- [ ] **Step 4: Replace only the sidebar layout block in `App.tsx`**

Keep session hydration, ordering, creation, rename, archive and workspace selection callbacks in `App.tsx`; pass them as props.

- [ ] **Step 5: Run focused and existing session tests**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkspaceSidebar.test.tsx ui/src/hooks/useDesktopSessions.test.tsx`

Expected: PASS; the empty-workspace regression remains covered.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/features/workbench/WorkspaceSidebar.tsx ui/src/features/workbench/WorkspaceSidebar.test.tsx
git commit -m "feat: separate workspace sidebar from conversation layout"
```

## Task 3: Compose a chat-first `ConversationPane` and task drawer

**Files:**
- Create: `ui/src/features/workbench/ConversationPane.tsx`
- Create: `ui/src/features/workbench/TaskPanel.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/features/workbench/WorkbenchShell.test.tsx`

**Interfaces:**
- Consumes existing conversation entries, run summary, task-loop summary, composer callbacks and run control callbacks.
- Produces a compact `TaskStatusBar` with `onOpenTaskDrawer(event)` and a `TaskPanel` receiving the current run/checkpoint data.

- [ ] **Step 1: Write the failing running-task visibility test**

```tsx
it("shows task progress in one compact line and opens complete details on demand", async () => {
  const user = userEvent.setup();
  render(<ConversationPane {...runningProps} />);
  expect(screen.getByText("正在重构前端")).toBeVisible();
  expect(screen.getByText("进行中 · 3 / 6")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "任务详情" }));
  expect(screen.getByRole("heading", { name: "任务" })).toBeVisible();
  expect(screen.getByText("本次证据")).toBeVisible();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkbenchShell.test.tsx`

Expected: FAIL because `ConversationPane` and `TaskPanel` are absent.

- [ ] **Step 3: Implement header, one-line task status and conversation slots**

Retain existing `ConversationTimeline`, response card, approval card, tool card and composer nodes as children/slots. Remove duplicated top-level action rows from the visual layout, but do not remove actions.

- [ ] **Step 4: Implement `TaskPanel` from existing run/checkpoint data**

Show status, plan steps, budget, checkpoints and existing pause/cancel/continue controls. The panel must not call bridge methods itself; it invokes callbacks from `App.tsx`.

- [ ] **Step 5: Run focused UI tests and test at 1366px viewport**

Run: `npm run test:ui -- --run ui/src/features/workbench/WorkbenchShell.test.tsx`

Expected: PASS; drawer is an overlay at 1366px and task controls remain reachable.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/features/workbench/ConversationPane.tsx ui/src/features/workbench/TaskPanel.tsx ui/src/features/workbench/WorkbenchShell.test.tsx
git commit -m "feat: make conversation the primary workbench surface"
```

## Task 4: Relocate approvals, tools and artifacts into context drawer tabs

**Files:**
- Create: `ui/src/features/workbench/ContextDrawer.tsx`
- Create: `ui/src/features/workbench/ApprovalPanel.tsx`
- Create: `ui/src/features/workbench/ToolPanel.tsx`
- Create: `ui/src/features/workbench/ArtifactPanel.tsx`
- Create: `ui/src/features/workbench/ContextDrawer.test.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes existing approval list/decision callback, live tool event data, artifacts and open/reveal callbacks.
- Produces `ContextDrawer({ activeTab, onTabChange, panels })`; `approval`, `tools`, and `artifacts` tabs have no new bridge APIs.

- [ ] **Step 1: Write failing pending-approval continuity test**

```tsx
it("keeps a pending approval actionable after opening the approval drawer tab", async () => {
  const user = userEvent.setup();
  render(<ContextDrawerHarness pendingApprovals={[pendingApproval]} />);
  await user.click(screen.getByRole("tab", { name: "审批" }));
  expect(screen.getByText("等待审批")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "允许一次" }));
  expect(decideApproval).toHaveBeenCalledWith(pendingApproval.id, "granted", "once");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test:ui -- --run ui/src/features/workbench/ContextDrawer.test.tsx`

Expected: FAIL because the drawer tabs and panel components do not exist.

- [ ] **Step 3: Implement tabs and move existing panel markup without changing actions**

Use semantic tabs (`role="tablist"`, `role="tab"`, `aria-selected`) and one active panel. Reuse `ApprovalCenter` and existing artifact button callbacks instead of reimplementing decisions or file operations.

- [ ] **Step 4: Run focused drawer tests**

Run: `npm run test:ui -- --run ui/src/features/workbench/ContextDrawer.test.tsx`

Expected: PASS; approval decision callback, tool event display and artifact callbacks still work.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/features/workbench/ContextDrawer.tsx ui/src/features/workbench/ApprovalPanel.tsx ui/src/features/workbench/ToolPanel.tsx ui/src/features/workbench/ArtifactPanel.tsx ui/src/features/workbench/ContextDrawer.test.tsx
git commit -m "feat: organize operational context in drawer tabs"
```

## Task 5: Finish the memory center and visual regression gate

**Files:**
- Create: `ui/src/features/workbench/MemoryPanel.tsx`
- Create: `ui/src/features/workbench/MemoryPanel.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: existing global UI style source discovered in Task 1

**Interfaces:**
- Consumes existing `DesktopMemory[]`, `DesktopMemoryCandidate[]`, refresh, accept, dismiss, mark-stale and forget callbacks.
- Produces `MemoryPanel({ candidates, memories, onAccept, onDismiss, onMarkStale, onForget })` with `candidate`, `active`, and `stale` filter values.

- [ ] **Step 1: Write failing stale-memory audit test**

```tsx
it("shows stale memories only under the stale filter and keeps delete available", async () => {
  const user = userEvent.setup();
  render(<MemoryPanel memories={[activeMemory, staleMemory]} candidates={[]} {...handlers} />);
  expect(screen.queryByText(staleMemory.summary)).toBeNull();
  await user.click(screen.getByRole("tab", { name: "已失效 1" }));
  expect(screen.getByText(staleMemory.summary)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(handlers.onForget).toHaveBeenCalledWith(staleMemory.id);
});
```

- [ ] **Step 2: Run focused test to verify it fails**

Run: `npm run test:ui -- --run ui/src/features/workbench/MemoryPanel.test.tsx`

Expected: FAIL because `MemoryPanel` does not exist.

- [ ] **Step 3: Implement memory filters and reuse current actions**

Candidate items expose only 保留/忽略. Active items expose 编辑 placeholder only if an existing save/edit bridge is present; otherwise keep 标记失效/删除. Stale items expose audit metadata and 删除. Do not add a fake edit control without a working backend operation.

- [ ] **Step 4: Remove the duplicated memory/settings visual blocks from `App.tsx`**

Keep provider and reusable-approval settings under settings; move memory management solely into the drawer/independent memory entry.

- [ ] **Step 5: Run all automated gates and desktop visual checks**

Run: `npm test && npm run test:ui && npm run test:electron && npm run desktop:typecheck`

Expected: all suites pass. Then build the desktop renderer and capture 1366×768, 1440×900 and 1920×1080 screenshots; compare each against Figma frames `01 · 主对话（聊天优先）`, `02 · 任务抽屉（按需展开）`, and `03 · 记忆中心（可追溯）` for clipping, overlap and unreachable controls.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/features/workbench/MemoryPanel.tsx ui/src/features/workbench/MemoryPanel.test.tsx ui/src/*.css
git commit -m "feat: complete workbench memory center"
```

## Final Verification

- [ ] Run `npm test`, `npm run test:ui`, `npm run test:electron`, and `npm run desktop:typecheck`.
- [ ] Verify no panel operation crosses workspaces, changes session timestamps on selection, or interrupts active runs.
- [ ] Compare packaged desktop screenshots with the linked Figma design at all three required window sizes.
- [ ] Review `git status --short`; do not stage existing unrelated local changes.

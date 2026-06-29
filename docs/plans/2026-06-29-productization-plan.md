# Shiguang Agent Productization Plan

> **For Hermes:** Use OpenCode for code-writing tasks in this repo. Keep feature work on the current feature branch. Verify every phase with `npm run typecheck`, `npm run build`, and desktop smoke tests.

**Goal:** turn the current framework skeleton + Craft-style desktop shell into a usable desktop agent product with real sessions, live runs, persisted state, and a pluggable LLM-backed planner.

**Current state (verified):**
- `src/brain/` exists with `RulePlanner`, `LlmPlanner`, and a dummy model.
- `src/app/agent.ts` can run a minimal loop.
- `ui/src/App.tsx` is a Craft-style shell, but it is mostly static demo data.
- `electron/preload.ts` only exposes `{ platform }`.
- `electron/main.ts` only boots the window; there is no IPC/app backend yet.

**Definition of done:**
1. Desktop app can create/select sessions.
2. User can send a message in the UI and see a real run execute.
3. Runs emit live events (thinking/message/tool_call/tool_result/finish/fail) into the UI.
4. Sessions/runs/events persist across app restarts.
5. Planner can be switched between rule-based and real LLM adapter config.
6. At least one real tool path works beyond demo echo.
7. Desktop package builds successfully.

---

## Phase 1 — Make the desktop shell real

### Task 1: Add a renderer-safe app API contract
**Objective:** define exactly what the UI can call and subscribe to.

**Files:**
- Create: `src/desktop/contracts.ts`
- Modify: `src/index.ts`

**Deliverables:**
- Types for `DesktopSessionSummary`, `DesktopRunSummary`, `DesktopEvent`, `DesktopArtifactSummary`
- IPC method contracts for:
  - `listSessions()`
  - `createSession(title?)`
  - `listRuns(sessionId)`
  - `sendUserMessage({ sessionId, message })`
  - `getSessionDetail(sessionId)`
  - `subscribeRunEvents(runId, callback)`

**Verify:** exports compile and are importable from renderer + main.

### Task 2: Add preload bridge for desktop API
**Objective:** expose a typed `window.shiguang` bridge instead of static platform-only data.

**Files:**
- Modify: `electron/preload.ts`
- Create: `ui/src/global.d.ts`

**Deliverables:**
- `contextBridge.exposeInMainWorld("shiguang", ...)`
- typed listener registration/unregistration for streamed run events

**Verify:** renderer typechecks against `window.shiguang`.

### Task 3: Add Electron IPC handlers in main process
**Objective:** make the window backend answer renderer requests.

**Files:**
- Modify: `electron/main.ts`
- Create: `electron/ipc.ts`

**Deliverables:**
- register `ipcMain.handle(...)` handlers
- route event subscriptions from runtime to renderer windows safely

**Verify:** basic roundtrip works from renderer to main and back.

---

## Phase 2 — Add real app state and persistence

### Task 4: Build a simple persistent desktop store
**Objective:** persist sessions/runs/events to disk so the app survives restart.

**Files:**
- Create: `src/state/file-store.ts`
- Create: `src/state/in-memory-repositories.ts`
- Modify: `src/state/index.ts`

**Approach:**
- Start with JSON-file persistence under app data dir for speed.
- Keep repository interfaces aligned with current `src/state/repositories.ts`.
- Defer SQLite swap until behavior is proven.

**Data to persist:**
- sessions
- tasks (minimal mapping okay)
- runs
- run events
- artifacts

**Verify:** create session, restart app, session still exists.

### Task 5: Add desktop app service layer
**Objective:** centralize session/run orchestration for Electron.

**Files:**
- Create: `src/desktop/service.ts`
- Create: `src/desktop/session-manager.ts`

**Responsibilities:**
- create default session
- create run records
- append run events
- return summaries formatted for UI
- map runtime events to desktop events

**Verify:** one service method can create a session and list it back.

---

## Phase 3 — Make the agent runnable from the desktop app

### Task 6: Add an app-level run executor
**Objective:** when the user submits text, start a real agent run.

**Files:**
- Modify: `src/app/agent.ts`
- Create: `src/app/run-agent.ts`
- Modify: `src/runtime/dispatcher.ts`

**Deliverables:**
- create run IDs automatically
- stream every action result into the event sink
- persist message outputs as run events
- attach finish/fail summaries

**Verify:** a message from UI produces a stored run with 2+ events.

### Task 7: Replace the dummy event sink with a fan-out sink
**Objective:** one runtime event should both persist and stream to UI listeners.

**Files:**
- Create: `src/runtime/multiplexed-event-sink.ts`
- Modify: `src/runtime/index.ts`

**Deliverables:**
- sink writes to repository
- sink notifies Electron subscribers
- sink keeps event ordering by run sequence

**Verify:** live UI receives events while repository stores them.

---

## Phase 4 — Wire the Craft-style UI to live data

### Task 8: Refactor static `App.tsx` into real panes
**Objective:** replace hardcoded demo data with stateful components.

**Files:**
- Modify: `ui/src/App.tsx`
- Create: `ui/src/components/Sidebar.tsx`
- Create: `ui/src/components/ChatPane.tsx`
- Create: `ui/src/components/DetailPane.tsx`
- Create: `ui/src/components/Composer.tsx`
- Create: `ui/src/hooks/useDesktopSessions.ts`
- Create: `ui/src/hooks/useRunEvents.ts`

**UI features:**
- session list from real API
- active session selection
- chat timeline from run events
- composer submits to backend
- right panel shows run/session details

**Verify:** hardcoded cards are gone; app still visually resembles Craft shell.

### Task 9: Add loading/running/error states
**Objective:** make the UI usable during real async runs.

**Files:**
- Modify: `ui/src/App.tsx`
- Modify relevant component files
- Modify: `ui/src/styles.css`

**Deliverables:**
- sending state in composer
- optimistic user message append
- tool-call timeline cards
- failure banner / retry affordance

**Verify:** user can distinguish idle/running/failed/completed runs.

---

## Phase 5 — Upgrade the brain from skeleton to usable adapter

### Task 10: Add real LLM adapter interface package boundary
**Objective:** keep the core package model-agnostic while making real adapters easy.

**Files:**
- Create: `src/brain/adapters/openai-compatible.ts`
- Create: `src/brain/config.ts`
- Modify: `src/brain/index.ts`

**Approach:**
- implement one OpenAI-compatible HTTP adapter using native `fetch`
- no heavyweight SDK required initially
- support `baseUrl`, `apiKey`, `model`

**Verify:** adapter can produce a `BrainAction` from a real HTTP response shape.

### Task 11: Add planner selection/configuration
**Objective:** choose rule planner vs LLM planner at app startup.

**Files:**
- Modify: `src/app/agent.ts`
- Modify: `src/desktop/service.ts`
- Create: `src/desktop/settings.ts`

**Deliverables:**
- settings-backed planner selection
- sensible fallback to `RulePlanner`
- visible active model/provider in UI detail pane

**Verify:** switch config and see runs use the chosen planner.

---

## Phase 6 — Make tools and artifacts product-grade

### Task 12: Add at least one useful real tool beyond echo
**Objective:** prove the tool architecture with an actual desktop-safe tool.

**Suggested first tool:** local file read/search within an allowed workspace.

**Files:**
- Create: `src/tools/builtins/read-file.ts`
- Create: `src/tools/builtins/search-files.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/app/agent.ts`

**Verify:** planner can request file read/search and UI shows tool call + result.

### Task 13: Surface artifacts in the right pane
**Objective:** make outputs first-class, not hidden in raw logs.

**Files:**
- Modify: `src/runtime/dispatcher.ts`
- Modify: `src/desktop/service.ts`
- Modify: `ui/src/components/DetailPane.tsx`

**Deliverables:**
- artifact summaries on tool output / generated text
- clickable artifact list in UI

**Verify:** a run creates at least one visible artifact entry.

---

## Phase 7 — Polish to ship

### Task 14: Add startup bootstrap and empty-state UX
**Objective:** app should feel finished on first open.

**Files:**
- Modify: `electron/main.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles.css`

**Deliverables:**
- auto-create first workspace/session
- friendly empty state
- preserve active session on reopen

### Task 15: End-to-end smoke tests / manual checklist
**Objective:** verify the full product path.

**Checklist:**
1. `npm run typecheck`
2. `npm run build`
3. `npm run desktop:typecheck`
4. `npm run desktop:build`
5. launch app
6. create session
7. send message
8. see live events
9. restart app
10. confirm history persists

### Task 16: Packaging
**Objective:** produce a usable desktop build artifact.

**Files:**
- Modify only if needed: `package.json`, Electron build config files

**Verify:** `npm run desktop:package` completes successfully.

---

## Recommended execution order right now

1. Phase 1 (desktop API bridge)
2. Phase 2 (persistent state)
3. Phase 3 (real run executor)
4. Phase 4 (wire UI)
5. Phase 5 (real LLM adapter)
6. Phase 6 (useful tools + artifacts)
7. Phase 7 (polish + packaging)

## What is currently missing before this is a “成品”

- no real Electron IPC app API
- no renderer/backend data bridge
- no persistent desktop data store
- no live event subscription path
- UI is still static mock data
- no real model adapter
- only demo echo tool
- no end-to-end packaged product flow

## Immediate next implementation slice

**Start with Phase 1 + Phase 2 together** so the static shell can become a real desktop app skeleton quickly.

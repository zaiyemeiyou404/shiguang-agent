# Frontend–Backend Feature-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the current Codex-style desktop frontend to every capability exposed by the former frontend, with complete response cards, tool activity, approvals, artifacts, recovery actions, session management, attachments, and provider settings.

**Architecture:** Keep the current project/workspace/session shell. Add a typed Electron contract, an explicitly disposable live-event subscription, and frontend hooks that normalize snapshots plus live events into one activity feed. Render operational detail in composable cards and a collapsible inspector instead of restoring the old fixed three-column layout.

**Tech Stack:** TypeScript, Node.js, SQLite, Electron IPC/context bridge, React 19, Vite 6, Vitest, Testing Library, CSS

**Spec:** `docs/superpowers/specs/2026-09-17-frontend-backend-parity-design.md`

## Global Constraints

- Preserve the current project → workspace → session hierarchy and the confirmed visual theme.
- Match the former frontend's behavior; visual placement may change but no user capability may disappear.
- Treat the workspace bound to the session as the only mutation scope; retain the existing read policy and terminal approval warning.
- Do not render raw backend payloads directly from React components. Normalize them through typed adapters with legacy fallbacks.
- Subscribe before loading event history, merge by event ID, sort by sequence, and explicitly release subscriptions.
- Clear composer text and attachments only after `sendUserMessage` succeeds.
- Every mutation must expose pending, success, empty, and failure states and must reject duplicate submission.

---

### Task 1: Lock the parity contract and add a UI test harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `ui/vitest.config.ts`
- Create: `electron/vitest.config.ts`
- Create: `ui/src/test/setup.ts`
- Create: `ui/src/features/activity/activity-model.test.ts`
- Create: `ui/src/features/approvals/approval-model.test.ts`

**Interfaces:**
- Produces: `npm run test:ui` for jsdom-based frontend tests and `npm run test:electron` for Node-based Electron service/IPC tests.
- Locks: the event-to-card and approval-request compatibility cases before production extraction begins.

- [ ] Add failing table-driven tests covering every event kind, legacy/missing payload fields, tool call/result pairing, duplicate event IDs, and sequence ordering.
- [ ] Add failing tests for approval normalization: command, file mutation, generic plugin capability, warnings, workspace path, malformed request, and terminal escape-risk copy.
- [ ] Add `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom`; configure `test:ui` and `test:electron` without changing the existing `npm test` command.
- [ ] Run `npm run test:ui` and verify failures are limited to the not-yet-created adapters.
- [ ] Commit the test-harness slice.

### Task 2: Make event and approval contracts explicit

**Files:**
- Modify: `electron/types.ts`
- Modify: `ui/src/bridge.ts`
- Modify: `electron/app-service.ts`
- Create: `electron/app-service.test.ts`
- Create: `ui/src/features/activity/activity-model.ts`
- Create: `ui/src/features/approvals/approval-model.ts`

**Interfaces:**
- Produces: discriminated `DesktopEvent` payload types for message, thinking, tool call/result, system/error, approval, and context compaction events.
- Produces: `ApprovalPresentation` with title, summary, target, working directory, warnings, structured details, and raw fallback.
- Produces: `buildActivityItems(events, conversation)` with stable response, thinking, tool, approval, system, and error item types.

- [ ] Add service tests proving events and pending approvals are serialized into the new canonical shapes while historical request shapes still normalize safely.
- [ ] Run `npm run test:electron -- app-service.test.ts` and `npm run test:ui`; confirm the new assertions fail against `payload: unknown` and `request: unknown` parsing.
- [ ] Define matching Electron and renderer DTO unions, including stable `toolCallId` and `approvalId` fields where available.
- [ ] Implement backend normalization at the desktop-service boundary; do not change stored historical rows.
- [ ] Implement pure activity and approval adapters with human-readable fallback content for malformed legacy data.
- [ ] Run the focused service and UI tests, then `npm run desktop:typecheck`.
- [ ] Commit the typed-contract slice.

### Task 3: Fix real-time event lifecycle and snapshot/live merging

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.cts`
- Modify: `ui/src/bridge.ts`
- Create: `electron/run-event-subscription.test.ts`
- Create: `ui/src/hooks/useRunActivity.ts`
- Create: `ui/src/hooks/useRunActivity.test.tsx`

**Interfaces:**
- Changes: `subscribeRunEvents` uses a subscription ID and a matching `unsubscribeRunEvents` IPC operation.
- Produces: `useRunActivity(runId)` returning `{ events, streamState, error, reconnect }`.

- [ ] Write a main-process test that subscribes, unsubscribes, switches runs, and destroys a sender; assert the service listener count returns to zero in every path.
- [ ] Write hook tests for subscribe-before-fetch, live events arriving during history fetch, ID deduplication, `seq` ordering, run switching, unmount cleanup, and stale-response rejection.
- [ ] Run `npm run test:electron -- run-event-subscription.test.ts` and `npm run test:ui -- useRunActivity.test.tsx`; verify the current renderer-only cleanup leaks the main-process subscription.
- [ ] Add tokenized subscribe/unsubscribe handlers and idempotent cleanup on both explicit disposal and sender destruction.
- [ ] Implement the hook using subscribe → fetch → merge, with a request generation guard for rapid session/run changes.
- [ ] Run the focused Electron/UI tests and `npm run desktop:typecheck`.
- [ ] Commit the event-stream slice.

### Task 4: Extract current session workspace state from the monolithic app

**Files:**
- Modify: `ui/src/hooks/useDesktopSessions.ts`
- Create: `ui/src/hooks/useSessionWorkspace.ts`
- Create: `ui/src/hooks/useSessionWorkspace.test.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Keeps: `useDesktopSessions` responsible for project/workspace/session hierarchy and session lifecycle.
- Produces: `useSessionWorkspace(sessionId)` for detail, selected run, approvals, artifacts, refresh, and independent mutation states.
- Consumes: `useRunActivity` from Task 3.

- [ ] Write hook tests for initial snapshot, session switching, selecting a historical run, refresh after approval, retry/cancel/branch, and rejection of stale async results.
- [ ] Run the hook tests and verify they fail before the extraction.
- [ ] Move snapshot, run, approval, artifact, and run-action state out of `App.tsx`; preserve existing user-visible behavior during the extraction.
- [ ] Keep approval pending state keyed by approval ID and run-action pending state keyed by run ID/action.
- [ ] Run UI tests, desktop typecheck, and a desktop build before changing card markup.
- [ ] Commit the state-boundary slice.

### Task 5: Implement the complete conversation activity feed

**Files:**
- Create: `ui/src/features/activity/ActivityFeed.tsx`
- Create: `ui/src/features/activity/ResponseCard.tsx`
- Create: `ui/src/features/activity/ThinkingCard.tsx`
- Create: `ui/src/features/activity/ToolActivityCard.tsx`
- Create: `ui/src/features/activity/SystemEventCard.tsx`
- Create: `ui/src/features/activity/ActivityFeed.test.tsx`
- Create: `ui/src/features/activity/activity.css`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: normalized activity items from Task 2.
- Replaces: the active layout's plain `SimpleChatTranscript` rendering.
- Produces: response cards, collapsible thinking cards, paired tool call/result cards, system/context cards, and error cards.

- [ ] Write component tests for historical messages, live assistant output, mixed runs, paired and orphan tool events, long arguments/results, errors, context compaction, auto-follow, and “jump to latest”.
- [ ] Run the component tests and verify the active simple layout cannot satisfy them.
- [ ] Render the new feed in the current central chat surface while retaining the compact project/workspace/session panes.
- [ ] Default thinking and successful tool detail to collapsed; expand errors and approval-blocking activity by default.
- [ ] Preserve readable plain-text whitespace, copy actions, timestamps, status labels, keyboard focus, and empty/loading/error states.
- [ ] Remove the obsolete active-path transcript only after parity tests pass; keep shared formatting helpers that are still used.
- [ ] Run `npm run test:ui`, `npm run desktop:typecheck`, and `npm run desktop:build`.
- [ ] Commit the activity-feed slice.

### Task 6: Complete operation-confirmation rendering and behavior

**Files:**
- Create: `ui/src/features/approvals/ApprovalCard.tsx`
- Create: `ui/src/features/approvals/ApprovalCard.test.tsx`
- Create: `ui/src/features/approvals/ApprovalCenter.tsx`
- Create: `ui/src/features/approvals/approvals.css`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/hooks/useSessionWorkspace.ts`

**Interfaces:**
- Consumes: `ApprovalPresentation` and `decideApproval`.
- Produces: inline blocking cards and a complete Review view over the same state and mutation handlers.

- [ ] Write tests for command/file/generic previews, workspace and target display, warning text, raw-detail disclosure, approve, reject, double-click suppression, API failure, expired approval, and approved-run resume feedback.
- [ ] Run the tests and verify failures expose the old generic card and global decision state limitations.
- [ ] Implement the new card with explicit “允许一次” and “拒绝” actions, per-approval progress, disabled terminal states, and accessible focus/labels.
- [ ] Keep terminal warnings honest: the command starts in the workspace but may reference absolute external paths.
- [ ] After a decision, reconcile the returned approval immediately, then refresh the session snapshot without flashing the card back to pending.
- [ ] Reuse the component in both the conversation and Review view; do not maintain two approval implementations.
- [ ] Run UI tests, desktop typecheck, and build.
- [ ] Commit the approval slice.

### Task 7: Restore run controls, inspector, artifacts, and failure recovery

**Files:**
- Create: `ui/src/features/run/RunToolbar.tsx`
- Create: `ui/src/features/run/RunInspector.tsx`
- Create: `ui/src/features/run/FailureRecoveryCard.tsx`
- Create: `ui/src/features/run/run-view-model.ts`
- Create: `ui/src/features/run/run-components.test.tsx`
- Create: `ui/src/features/artifacts/ArtifactCard.tsx`
- Create: `ui/src/features/artifacts/ArtifactPanel.tsx`
- Create: `ui/src/features/artifacts/artifact-components.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Produces: contextual cancel/retry/branch/continue controls and a collapsible inspector.
- Restores: run phase, timestamps, event counts, recent activity, run history, pending approvals, provider summary, artifacts, and failure-repair actions.

- [ ] Write tests for action availability across every run status, rapid repeated actions, historical-run selection, run-specific artifact filtering, and local/HTTP artifact action availability.
- [ ] Port failure insight fixtures from the legacy helpers and test copy evidence, draft repair prompt, send repair prompt, retry, and branch flows.
- [ ] Run UI tests and verify the current active layout lacks the inspector and full artifact/recovery surface.
- [ ] Build the toolbar and on-demand inspector using the existing service calls; keep the chat width unchanged while the inspector is closed.
- [ ] Implement artifact copy/open/reveal and navigation to the owning session/run, with errors shown beside the attempted action.
- [ ] Delete or consolidate legacy-only helper/component code after the new components cover all former behavior.
- [ ] Run UI tests, desktop typecheck, and build.
- [ ] Commit the operations slice.

### Task 8: Preserve composer, session lifecycle, Home, and settings parity

**Files:**
- Create: `ui/src/features/composer/Composer.tsx`
- Create: `ui/src/features/composer/Composer.test.tsx`
- Create: `ui/src/features/settings/SettingsDrawer.tsx`
- Create: `ui/src/features/settings/SettingsDrawer.test.tsx`
- Create: `ui/src/features/home/HomeView.tsx`
- Create: `ui/src/features/sessions/SessionActions.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Preserves: attachment picking/removal, drafts, send semantics, session search/filter/pin/lifecycle, Home shortcuts, and full provider configuration.
- Keeps: global `workspaceRoot` visible only as migration compatibility, never as the active scope selector.

- [ ] Write composer tests for Enter/Shift+Enter, attachment-only send, failed-send retention, successful-send clearing, disabled states, and per-session draft restoration.
- [ ] Write settings tests for provider add/copy/rename/delete/reorder, protocol/auth fields, secret masking, connection test, import/export, dirty-state diff, revert, presets, save failure, and close-with-unsaved-changes.
- [ ] Write session/Home tests for search, all filters, pinning, status badges, new/rename/archive/restore/delete, recent-session navigation, Review shortcut, and unavailable-workspace messaging.
- [ ] Run UI tests and verify all missing cases fail before extraction.
- [ ] Extract the composer, settings, Home, and session action components from `App.tsx`, preserving their existing bridge calls and adding the tested failure guards.
- [ ] Confirm no setting can silently change a session's bound workspace and no failed send loses user input.
- [ ] Run UI tests, desktop typecheck, and build.
- [ ] Commit the remaining parity slice.

### Task 9: End-to-end parity audit and release verification

**Files:**
- Create: `docs/desktop-frontend-parity-checklist.md`
- Modify: `README.md`
- Modify: affected production/test files only when a failing regression test demonstrates a parity defect.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: a signed-off mapping from every row in the specification's parity matrix to an automated test and a desktop smoke step.

- [ ] Run `npm test`; for each regression caused by this work, add a failing test before changing production code.
- [ ] Run `npm run test:electron`, `npm run test:ui`, `npm run desktop:typecheck`, and `npm run desktop:build`.
- [ ] Start the desktop app against a temporary data directory and verify: create workspace/session, send with attachment, receive response, render tool call/result, approve and reject operations, cancel/retry/branch, open/reveal artifacts, recover from a failed run, and edit/test/save provider settings.
- [ ] During the smoke test, switch repeatedly between two live runs and verify no cross-run event appears and the main-process subscription count returns to zero after each switch.
- [ ] Restart the app and verify project/workspace/session selection, history, runs, approvals, artifacts, pins, drafts, and settings restore according to their documented persistence rules.
- [ ] Test keyboard navigation and readable focus states for composer, activity disclosures, approval actions, toolbar, inspector, dialogs, and settings.
- [ ] Record every parity-matrix row, its automated test, its manual check, and the observed result in `docs/desktop-frontend-parity-checklist.md`.
- [ ] Update README with the new UI organization and safety semantics, review the complete diff against the spec, and commit the verified integration.

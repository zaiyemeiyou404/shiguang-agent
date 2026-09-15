# Project Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent projects and folder-backed workspaces, bind every session to a workspace, enforce workspace-scoped mutations, and expose the hierarchy in the desktop UI.

**Architecture:** SQLite owns Project, Workspace, and Session relationships. Electron resolves a session's workspace before constructing its agent runtime; read tools may accept explicit absolute paths while mutation tools retain strict workspace containment. React consumes project/workspace APIs and groups compact session rows under the selected hierarchy.

**Tech Stack:** TypeScript, Node.js, SQLite, Electron IPC, React 19, CSS, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-15-project-workspace-design.md`

## Global Constraints

- A session is permanently bound to exactly one workspace.
- Session branches inherit the source workspace.
- Relative paths resolve from the session workspace.
- Mutating file tools must reject paths outside the workspace root.
- Read tools may accept explicit absolute paths subject to operating-system permissions.
- Arbitrary terminal commands always require approval and are not presented as a strong filesystem sandbox.
- Existing history must migrate to a default project and default workspace without data loss.

---

### Task 1: Persistent project/workspace model and migration

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/state/schema.ts`
- Modify: `src/state/repositories.ts`
- Create: `src/state/sqlite-project-repository.ts`
- Create: `src/state/sqlite-workspace-repository.ts`
- Modify: `src/state/sqlite-session-repository.ts`
- Modify: `src/state/index.ts`
- Create: `src/state/project-workspace.test.ts`

**Interfaces:**
- Produces: `Project`, `Workspace`, `ProjectRepository`, `WorkspaceRepository` and workspace-aware `SessionRepository`.
- Produces: schema migration 002 adding `projects`, `workspaces`, and `sessions.workspace_id`.

- [ ] Write integration tests that open a version-1 database, run migrations, and assert old sessions receive the default workspace.
- [ ] Run `npm test -- project-workspace` and verify the new tests fail because schema version 2 and repositories do not exist.
- [ ] Add the types, repositories, migration, and row mapping with deterministic default IDs.
- [ ] Run the focused tests and verify they pass.
- [ ] Commit the persistence slice.

### Task 2: Desktop service and IPC contracts

**Files:**
- Modify: `electron/types.ts`
- Modify: `electron/store.ts`
- Modify: `electron/app-service.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.cts`
- Modify: `ui/src/bridge.ts`
- Modify: `ui/src/global.d.ts`
- Create: `electron/project-workspace.test.ts`

**Interfaces:**
- Consumes: repositories and model types from Task 1.
- Produces: project/workspace list and create APIs plus `createSession({ title?, workspaceId })`.

- [ ] Write service-level tests for creating a workspace-bound session, rejecting an unknown workspace, and inheriting workspace on branch.
- [ ] Run the focused tests and verify failures identify the old title-only session API.
- [ ] Add DTOs, service methods, IPC handlers, preload bridge methods, and workspace availability checks.
- [ ] Make runtime creation resolve the root from the session's workspace rather than desktop settings.
- [ ] Run the focused tests and desktop typecheck.
- [ ] Commit the desktop contract slice.

### Task 3: Read/write path policy

**Files:**
- Create: `src/tools/builtins/path-policy.ts`
- Modify: `src/tools/builtins/read-text-file.ts`
- Modify: `src/tools/builtins/list-directory.ts`
- Modify: `src/tools/builtins/stat-path.ts`
- Modify: `src/tools/builtins/search-workspace.ts`
- Modify: `src/tools/builtins/run-terminal-command.ts`
- Modify: `src/tools/builtins/read-text-file.test.ts`
- Modify: `src/tools/builtins/list-directory.test.ts`
- Modify: `src/tools/builtins/stat-path.test.ts`
- Modify: `src/tools/builtins/search-workspace.test.ts`
- Modify: `src/tools/builtins/run-terminal-command.test.ts`

**Interfaces:**
- Produces: `resolveReadablePath(workspaceRoot, requestedPath)` and `resolveWritablePath(workspaceRoot, requestedPath)`.
- Keeps: mutation tools' existing containment behavior.

- [ ] Add tests proving explicit absolute read paths work while relative paths remain workspace-relative.
- [ ] Add a terminal descriptor test proving approval is always required and its warning does not claim sandboxing.
- [ ] Run the focused tests and verify they fail under the old workspace-only read resolver.
- [ ] Implement the shared path policy and update the read tools and terminal description.
- [ ] Run all built-in tool tests.
- [ ] Commit the permission-policy slice.

### Task 4: React hierarchy and workspace creation

**Files:**
- Modify: `ui/src/hooks/useDesktopSessions.ts`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: project/workspace/session DTOs and bridge methods from Task 2.
- Produces: project → workspace → session sidebar and current-workspace task creation.

- [ ] Add pure grouping/selection helpers and tests for project/workspace/session ordering.
- [ ] Run the UI-focused test or typecheck and verify the new workspace fields are missing.
- [ ] Load projects and workspaces with sessions, persist the active workspace selection, and pass its ID when creating sessions.
- [ ] Add compact grouped sidebar rows, workspace creation UI, and project/workspace context in the conversation header.
- [ ] Remove the global workspace input as the active runtime selector while preserving migration compatibility.
- [ ] Run desktop typecheck and build.
- [ ] Commit the UI slice.

### Task 5: Migration and end-to-end verification

**Files:**
- Modify as required by failures in Tasks 1–4, with regression tests added beside the affected code.
- Modify: `README.md`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: documented upgrade behavior and verified desktop bundle.

- [ ] Run `npm test` and fix only failures caused by this feature, adding a failing regression test before each production fix.
- [ ] Run `npm run desktop:typecheck` and resolve contract mismatches.
- [ ] Run `npm run desktop:build` and confirm Electron and UI bundles succeed.
- [ ] Exercise creation of two workspaces and verify sessions retain distinct roots after restart.
- [ ] Document the hierarchy, migration, read/write boundary, and terminal approval limitation.
- [ ] Review the final diff against every acceptance criterion in the spec, then commit the completed feature.

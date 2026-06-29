# MVP Plan

The MVP should prove the architecture with the fewest moving parts: local state, explicit runs, inspectable events, and one safe plugin path.

## Build Order

1. **Domain contracts**
   - Add TypeScript types for sessions, tasks, runs, events, artifacts, memories, plugins, and approvals.
   - Keep these framework-free.

2. **SQLite state**
   - Add migrations for the core tables.
   - Build small repository modules for creating sessions, tasks, runs, events, and artifacts.
   - Avoid an ORM until schema pressure justifies it.

3. **Run lifecycle**
   - Implement `startRun`, `appendRunEvent`, `finishRun`, and `failRun`.
   - Ensure every state transition is persisted.
   - Add a run summary field even before automatic summarization exists.

4. **Context builder**
   - Combine current user turn, task description, recent run summaries, and linked artifacts.
   - Return structured context items with provenance.
   - Add budget trimming before model integration.

5. **Plugin manifest and adapter**
   - Define a plugin manifest type.
   - Add one local read-only example plugin, such as filesystem file metadata or repository search.
   - Record every plugin call as a run event.

6. **Developer CLI**
   - Commands: create session, add task, start run, list events, inspect state.
   - Keep it local and scriptable.

7. **First model loop**
   - Add a single bounded agent step that receives a context bundle and emits events.
   - Defer autonomous multi-step behavior until state and observability are solid.

## Non-Goals For MVP

- Full UI
- Multi-user auth
- Remote service deployment
- Complex memory embeddings
- Marketplace-style plugin loading
- Browser or computer-control automation
- Long-running autonomous plans

## Acceptance Criteria

- A developer can create a session and task from the CLI.
- A run can be started, observed through events, and completed or failed.
- Context assembly is deterministic and inspectable.
- Plugin calls are permissioned by manifest and recorded in state.
- The project remains dependency-light and easy to reason about.


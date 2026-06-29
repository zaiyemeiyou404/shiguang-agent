# Architecture

拾光 is organized as a hybrid agent architecture with a small orchestration core and replaceable boundaries for context, state, runtime execution, and plugins.

## Layers

1. **Interface layer**
   - Future CLI, local app, web UI, or API surface.
   - Creates sessions, sends user turns, displays run events, and manages approvals.

2. **Core orchestration layer**
   - Owns session/task/run lifecycle rules.
   - Decides when to plan, execute, pause, resume, summarize, or store memory.
   - Does not call external systems directly.

3. **Context layer**
   - Builds prompt/runtime context from user input, task state, memory, artifacts, files, and plugin-provided references.
   - Tracks provenance for every context item.
   - Applies ranking and compression before execution.

4. **Runtime layer**
   - Executes bounded agent runs.
   - Streams events, records tool calls, handles cancellation, and normalizes errors.
   - Mediates model/tool interaction through core contracts.

5. **Plugin layer**
   - Wraps external capabilities such as shell, browser, GitHub, calendar, filesystem, or app connectors.
   - Declares capabilities, permissions, input/output schemas, and side-effect class.
   - Cannot mutate core state except through approved runtime APIs.

6. **State layer**
   - Persists sessions, tasks, runs, events, artifacts, memories, plugin registrations, and approvals.
   - Starts with SQLite and local artifact storage.

## Context System Design

Context is assembled as typed records, not plain concatenated text.

Core context item fields:

- `id`: stable identifier
- `kind`: `user_turn`, `task_state`, `memory`, `artifact`, `file_ref`, `plugin_ref`, `run_summary`
- `source`: local path, plugin id, memory id, or generated system source
- `content`: compact text payload or reference pointer
- `provenance`: when and how the item entered context
- `score`: retrieval/ranking score
- `budget`: estimated token or size cost

Suggested pipeline:

1. Collect required context from current session, task, and active run.
2. Retrieve candidate memory and artifacts by task/session affinity.
3. Ask plugins for references only when their manifest allows passive reads.
4. Rank by recency, relevance, explicit user mentions, and task linkage.
5. Compress long items into summaries while preserving source pointers.
6. Emit a final context bundle with provenance metadata.

## Session, Task, Run, Memory

- **Session**: a user-facing conversation or workspace. It contains turns, tasks, and high-level summaries.
- **Task**: a durable unit of work inside a session. A task may have status, priority, parent/child links, artifacts, and acceptance notes.
- **Run**: one bounded execution attempt against a task or session turn. Runs produce events, tool calls, artifacts, and summaries.
- **Memory**: durable knowledge extracted from sessions, tasks, runs, or explicit user input. Memory is queryable but should keep provenance and confidence.

Relationships:

- one session has many tasks
- one task has many runs
- one run has many events and tool calls
- one task has many artifacts
- memory may link to session, task, run, artifact, or none
- plugins may create artifacts and events only through runtime-mediated writes

## Plugin Boundaries

Plugins are adapters, not business logic containers.

Each plugin should define:

- `plugin_id` and version
- capabilities such as `read_file`, `write_file`, `search_repo`, `open_browser`, `send_message`
- permission requirements and side-effect class: `read`, `write`, `network`, `external_mutation`
- input/output schemas
- timeout and cancellation behavior
- whether calls are replayable or must be treated as non-deterministic

Core rules:

- Plugins do not access SQLite directly.
- Plugins receive scoped run context, not global session state.
- Plugin results are normalized into runtime events.
- External mutations require an approval record unless policy says otherwise.

## Suggested SQLite Layout

Initial tables:

- `sessions(id, title, status, created_at, updated_at, summary)`
- `turns(id, session_id, role, content, created_at)`
- `tasks(id, session_id, parent_task_id, title, description, status, priority, created_at, updated_at)`
- `runs(id, session_id, task_id, status, reason, started_at, ended_at, model, summary)`
- `run_events(id, run_id, seq, kind, payload_json, created_at)`
- `tool_calls(id, run_id, plugin_id, capability, status, input_json, output_json, error, started_at, ended_at)`
- `artifacts(id, session_id, task_id, run_id, kind, uri, title, metadata_json, created_at)`
- `memories(id, scope, content, source_type, source_id, confidence, created_at, updated_at)`
- `memory_links(memory_id, target_type, target_id)`
- `plugins(id, version, manifest_json, enabled, created_at, updated_at)`
- `approvals(id, run_id, plugin_id, capability, status, request_json, decided_at)`

Indexes:

- `tasks(session_id, status)`
- `runs(task_id, started_at)`
- `run_events(run_id, seq)`
- `tool_calls(run_id, plugin_id)`
- `artifacts(task_id, created_at)`
- `memories(scope, updated_at)`
- `memory_links(target_type, target_id)`

Keep migrations append-only and owned by `src/state`.


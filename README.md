# 拾光 (shiguang-agent)

拾光 is a lightweight hybrid agent runtime: part personal workflow agent, part extensible tool orchestrator, and part durable memory layer.

This repo is a **TypeScript framework skeleton** — ready to wire in a model, CLI, or UI. All public contracts and module boundaries are concrete code, not just stubs.

## Module Map

```
src/
├── core/        # Domain types: Session, Task, Run, RunEvent, ToolCall, Artifact, Memory, Approval
├── context/     # ContextItem types, Provenance, buildContext(), trimToBudget()
├── runtime/     # RuntimeCoordinator, InMemoryEventSink, RunLifecycleCommand
├── plugins/     # PluginManifest, PluginRegistry, PluginAdapter, example-fs adapter
├── state/       # SQLite schema (migration strings), repository interfaces
├── kernel/      # Kernel — composition root that wires runtime + plugins + repositories
└── index.ts     # Barrel exports
```

## How to Extend

| Goal | What to do |
|---|---|
| Add a new domain type | Add interface in `src/core/types.ts`, add table in `src/state/schema.ts`, add a repository interface in `src/state/repositories.ts` |
| Add a plugin | Create a new adapter in `src/plugins/` following the `PluginAdapter` interface, register it in `PluginRegistry` |
| Wire SQLite | Implement `Repositories` from `src/state/repositories.ts` using better-sqlite3 or libsql |
| Add a model loop | Import `ContextBundle`, build it with `buildContext()`, feed to a model, call `RuntimeCoordinator.handle()` for each event |
| Build a CLI | Import `Kernel` from `src/kernel/`, inject repositories and plugin registry |

## Quick Start

```bash
npm install
npm run build        # compiles src/ → dist/
npm run typecheck    # type-check without emitting
```

No runtime dependencies. Only `typescript` as a dev dependency.

## Design

- **Small core, strong boundaries**: orchestration, context, state, and plugins remain separate.
- **Durable by default**: every state transition is persisted.
- **Human steerable**: every run is inspectable, interruptible, and resumable.
- **Tool agnostic**: plugins only know contracts defined in `src/plugins/types.ts`.
- **Context is a product surface**: typed items with provenance, score, and budget.

## Current Status

v0.2.0 — Framework skeleton with real TypeScript contracts, a composition root, SQLite migration strings, an in-memory event sink, a context builder with budget trimming, and a read-only example filesystem plugin.

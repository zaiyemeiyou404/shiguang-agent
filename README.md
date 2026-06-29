# 拾光 (shiguang-agent)

拾光 is a lightweight hybrid agent runtime: part personal workflow agent, part extensible tool orchestrator, and part durable memory layer. It is inspired by Hermes-style agent loops, Craft-style structured task workspaces, and OpenClaw-style pluggable computer/tool control.

This repository is intentionally architecture-first. The initial goal is to define clean boundaries and a small MVP path before building a full product.

## Vision

拾光 helps users turn intent into tracked, resumable work:

- capture a request as a session and task graph
- gather context from local files, tools, plugins, and memory
- run bounded agent steps with explicit state transitions
- preserve useful decisions, artifacts, and summaries across runs
- expose extension points without coupling core logic to any one UI or tool

## Design Principles

- **Small core, strong boundaries**: orchestration, context, state, and plugins remain separate.
- **Durable by default**: sessions, tasks, runs, artifacts, and memory are persisted before they become complex.
- **Human steerable**: every run should be inspectable, interruptible, and resumable.
- **Tool agnostic**: plugins adapt external capabilities; the core only knows contracts.
- **Context is a product surface**: retrieval, compression, and provenance are first-class.
- **Local-first MVP**: SQLite, filesystem artifacts, and TypeScript modules before services.

## Module Overview

- `src/core`: agent loop contracts, task planning abstractions, run lifecycle types.
- `src/context`: context assembly, ranking, summarization, and provenance records.
- `src/runtime`: execution host for agent runs, tool calls, cancellation, and streaming events.
- `src/plugins`: plugin manifests, capability boundaries, permissions, and adapters.
- `src/state`: SQLite schema ownership, repositories, migrations, and state models.

## MVP Roadmap

1. Define TypeScript domain types for sessions, tasks, runs, memory, artifacts, and plugins.
2. Add SQLite migrations and repository interfaces.
3. Implement a minimal run lifecycle: create session, create task, start run, append events, finish run.
4. Add a context builder that can combine user input, recent run summaries, task state, and file references.
5. Add one example plugin adapter with a strict manifest and permission model.
6. Build a CLI developer harness for creating sessions and inspecting run state.

## Current Status

Bootstrap scaffold only. No product workflow, agent model integration, database implementation, or plugin execution has been built yet.


# Source Layout

This directory holds placeholder module boundaries for the initial 拾光 runtime.

- `core`: orchestration contracts and lifecycle rules
- `context`: context item models, assembly, ranking, and compression
- `runtime`: run execution host, event stream, tool-call mediation
- `plugins`: manifest types, permissions, and adapter contracts
- `state`: SQLite schema ownership, repositories, and migrations

Implementation should start with shared domain types, then SQLite state, then the run lifecycle.


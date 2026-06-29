# Core

Owns agent orchestration contracts:

- session lifecycle
- task lifecycle
- run state transitions
- planning and execution boundaries

The core should depend on interfaces for state, context, runtime, and plugins rather than concrete implementations.


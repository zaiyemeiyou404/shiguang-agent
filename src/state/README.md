# State

Owns durable local state:

- SQLite migrations
- repository interfaces
- session, task, run, event, artifact, memory, plugin, and approval records

Keep migrations append-only and repositories narrow.


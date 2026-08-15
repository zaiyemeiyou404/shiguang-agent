# Shiguang Workspace Policy

`shiguang.workspace.policy.v1` is the single path decision layer for Shiguang Agent desktop storage.

## Why it exists

Before this layer, storage paths were decided in several Electron files:

- Electron `userData`
- desktop config path
- session cache path
- SQLite state path
- dedicated memory database path
- default workspace path
- legacy AppData migration sources

That made it easy for memories, settings, and workspace files to drift into different locations. Workspace Policy turns those decisions into one testable contract.

## Policy flow

```text
Electron app/env/process paths
  -> resolveWorkspacePolicy()
  -> userDataRoot/config/state/memory/workspace/migration paths
  -> Electron services consume the resolved paths
```

Implementation:

- `src/workspace/policy.ts`
- `electron/user-data.ts`
- `electron/config.ts`
- `electron/store.ts`
- `electron/app-service.ts`

## Data root decision

| Runtime | Data root |
|---|---|
| Environment override | `SHIGUANG_USER_DATA_DIR` or `SHIGUANG_DATA_DIR` |
| Development build | `<repo>/shiguang-agent-data/` |
| Local `release/win-unpacked` or `release/linux-unpacked` | `<repo>/shiguang-agent-data/` |
| Installed Windows build with `G:` | `G:\CodexData\shiguang-agent-data\` |
| Installed/portable build without preferred root | folder next to the executable |

## Paths produced by the policy

| Field | Purpose |
|---|---|
| `userDataRoot` | Electron `userData` root |
| `configPath` | `shiguang.config.json` |
| `storePath` | `shiguang-store.json` desktop session cache |
| `stateDbPath` | `shiguang-state.sqlite` runtime state |
| `memoryDbPath` | `memory/shiguang-memory.sqlite` long-term memory |
| `defaultWorkspaceRoot` | default tool/terminal workspace |
| `legacyUserDataSources` | AppData migration sources |

## Relationship to other contracts

- Provider Contract answers: what can this model endpoint do?
- Tool Contract answers: what can this tool do, and what risk does it carry?
- Workspace Policy answers: where is this user's local state and workspace allowed to live?

Together they make the agent runtime less dependent on scattered Electron-specific path decisions.

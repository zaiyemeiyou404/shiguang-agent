# Data directory and clean uninstall

Shiguang Agent redirects Electron `userData` into an app-owned data directory instead of the default Windows roaming AppData location.

## Data location

- Development build: `<repo>/shiguang-agent-data/`
- Local `release/win-unpacked` / `release/linux-unpacked` test build: `<repo>/shiguang-agent-data/`
- Installed Windows build with `G:` available: `G:\CodexData\shiguang-agent-data\`
- Installed Windows build without `G:`: a `shiguang-agent-data/` folder next to `拾光 Agent.exe`

The path is resolved by `shiguang.workspace.policy.v1`, so Electron `userData`, desktop config, session cache, state database, memory database, default workspace, and legacy migration all share the same root decision.

Main files:

- `shiguang-state.sqlite`: conversations, runs, approvals, artifacts, and runtime events
- `shiguang-store.json`: lightweight desktop session cache
- `shiguang.config.json`: desktop settings and provider config
- `memory/shiguang-memory.sqlite`: dedicated long-term memory database
- `workspace/`: default workspace for tools and terminal commands

Provider API keys saved from the desktop settings panel are protected with Electron `safeStorage` when OS encryption is available. Legacy plaintext keys in `shiguang.config.json` are migrated to an `encryptedApiKey` field on the next config read/save.

You can override the data directory with either environment variable:

- `SHIGUANG_USER_DATA_DIR`
- `SHIGUANG_DATA_DIR`

## Migration

On first launch, the app attempts to migrate legacy files from:

- `%APPDATA%\shiguang-agent`
- `%APPDATA%\Electron`

After migration, the old `shiguang-agent` AppData directory is removed best-effort.

## Uninstall choice

The Windows installer asks whether to delete local data during uninstall.

Choose **Yes** for a clean uninstall. This removes:

- `$INSTDIR\shiguang-agent-data`
- `%APPDATA%\shiguang-agent`
- legacy Shiguang files under `%APPDATA%\Electron`

Choose **No** to keep conversations, memories, settings, provider config, and caches for a later reinstall.

For the unpacked portable build, deleting the app folder also deletes the app-owned `shiguang-agent-data/` folder if it is kept next to the executable.

For installed builds that use `G:\CodexData\shiguang-agent-data\`, clean uninstall also removes that policy-selected data directory when the user chooses to delete local data.

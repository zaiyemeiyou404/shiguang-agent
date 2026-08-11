# Data directory and clean uninstall

Shiguang Agent redirects Electron `userData` into an app-owned data directory instead of the default Windows roaming AppData location.

## Data location

- Development build: `<repo>/shiguang-agent-data/`
- Packaged build: a `shiguang-agent-data/` folder next to `拾光 Agent.exe`

If the app is placed on `G:`, the state database, config, session cache, Chromium cache, and memory data stay under that `G:` app folder.

Main files:

- `shiguang-state.sqlite`: conversations, runs, approvals, artifacts, and memories
- `shiguang-store.json`: lightweight desktop session cache
- `shiguang.config.json`: desktop settings and provider config

You can override the data directory with either environment variable:

- `SHIGUANG_USER_DATA_DIR`
- `SHIGUANG_DATA_DIR`

## Migration

On first launch, the app attempts to migrate legacy files from:

- `%APPDATA%\shiguang-agent`
- `%APPDATA%\Electron`

After migration, the old `shiguang-agent` AppData directory is removed best-effort.

## Clean uninstall

The Windows installer includes a custom NSIS uninstall step that removes:

- `$INSTDIR\shiguang-agent-data`
- `%APPDATA%\shiguang-agent`
- legacy Shiguang files under `%APPDATA%\Electron`

For the unpacked portable build, deleting the app folder also deletes the app-owned `shiguang-agent-data/` folder if it is kept next to the executable.

# 拾光 (shiguang-agent)

拾光 is a lightweight hybrid agent runtime: part personal workflow agent, part extensible tool orchestrator, and part durable memory layer.

This repo is a **TypeScript framework skeleton** — ready to wire in a model, CLI, or UI. All public contracts and module boundaries are concrete code, not just stubs.

## Module Map

```
src/
├── core/        # Domain types: Session, Task, Run, RunEvent, ToolCall, Artifact, Memory, Approval
├── context/     # ContextItem types, Provenance, buildContext(), trimToBudget()
├── brain/       # BrainInput, BrainAction, Planner (rule & LLM), Policy, Evaluator, loop orchestrator
├── tools/       # Tool interface, ToolRegistry, builtins (echo)
├── runtime/     # RuntimeCoordinator, InMemoryEventSink, RunLifecycleCommand, ActionDispatcher
├── plugins/     # PluginManifest, PluginRegistry, PluginAdapter, example-fs adapter
├── state/       # SQLite schema (migration strings), repository interfaces, InMemoryRunStore
├── kernel/      # Kernel — composition root that wires runtime + plugins + repositories
├── app/         # Agent — composition root for the brain loop (planner + policy + evaluator + dispatcher)
└── index.ts     # Barrel exports
```

## How to Extend

| Goal | What to do |
|---|---|
| Add a new domain type | Add interface in `src/core/types.ts`, add table in `src/state/schema.ts`, add a repository interface in `src/state/repositories.ts` |
| Add a plugin | Create a new adapter in `src/plugins/` following the `PluginAdapter` interface, register it in `PluginRegistry` |
| Wire SQLite | Implement `Repositories` from `src/state/repositories.ts` using better-sqlite3 or libsql |
| Add a model loop | Import `ContextBundle`, build it with `buildContext()`, feed to a model, call `RuntimeCoordinator.handle()` for each event |
| Use an LLM planner | Inject `LlmPlanner` (with your `LlmPlannerModel` implementation) via `AgentOptions.planner` instead of the default `RulePlanner` |
| Build a CLI | Import `Kernel` from `src/kernel/`, inject repositories and plugin registry |

## Quick Start

```bash
npm install
npm run build        # compiles src/ → dist/
npm run typecheck    # type-check without emitting
```

No runtime dependencies for the library. Only `typescript` as a dev dependency.

## Desktop App

A Vite + React + Electron desktop shell is provided alongside the library:

```
electron/          # Electron main process (main.ts) & preload
ui/                # Vite + React renderer
  index.html       # Entry HTML
  src/
    main.tsx       # React mount
    App.tsx        # Craft-style desktop shell (components inline)
    styles.css     # All styling (ported from examples/craft-style-shell.html)
tsconfig.electron.json  # TypeScript config for electron/
tsconfig.ui.json        # TypeScript config for ui/src (type-check only; Vite handles build)
```

### Commands

| Script | What it does |
|---|---|
| `npm run desktop:dev` | Build core library + Electron main process, then start Vite dev server + Electron together (concurrently) |
| `npm run desktop:vite` | Vite dev server on port 5173 |
| `npm run desktop:electron` | Launch Electron pointing at dev server (ELECTRON_DEV set automatically) |
| `npm run desktop:build` | Build core library, compile Electron main process, then build UI with Vite |
| `npm run desktop:typecheck` | Build core library (for type declarations), then type-check both electron/ and ui/ without emitting |
| `npm run desktop:package` | Build + package for Linux as an unpacked directory (no Wine required) |
| `npm run desktop:package:linux` | Build + package for Linux as a full distributable (AppImage/deb/etc.) |
| `npm run desktop:package:win` | Build + package for Windows (nsis/x64) via electron-builder |

To run the desktop app in development:
```bash
npm install
npm run desktop:dev
```

To package for the current Linux host (recommended for CI/validation):
```bash
npm run desktop:package
```

To package for Windows (requires a Windows environment or Wine):
```bash
npm run desktop:package:win
```

### Windows Run Guide

Yes — the **project can run on Windows**, but the current checked build artifact in this repo is Linux-only (`release/linux-unpacked/`). On a real Windows machine, use the source tree and run/build there.

#### Prerequisites

- Node.js 20+
- npm 10+
- Windows 10/11 x64

#### Run in development on Windows

Open PowerShell in the repo root:

```powershell
npm install
$env:SHIGUANG_WORKSPACE_ROOT = "C:\\path\\to\\your\\project"
npm run desktop:dev
```

If you want to use the built-in local `RulePlanner`, you can stop there — no API key is required.

To enable a real OpenAI-compatible model in PowerShell:

```powershell
$env:SHIGUANG_LLM_API_KEY = "sk-..."
$env:SHIGUANG_LLM_MODEL = "deepseek-chat"
$env:SHIGUANG_LLM_BASE_URL = "https://api.deepseek.com/v1"
$env:SHIGUANG_WORKSPACE_ROOT = "C:\\path\\to\\your\\project"
npm run desktop:dev
```

#### Build a Windows installer

```powershell
npm install
npm run desktop:package:win
```

This produces an NSIS x64 installer under `release/`. The installer will be **unsigned** — Windows SmartScreen and antivirus may flag it on first run. This is expected for local/development builds. To produce a signed installer later, add a code-signing certificate configuration (for example `win.certificateFile` / `win.certificatePassword`) and re-enable executable signing in `package.json`.

##### Known issues

- **winCodeSign / sign-edit-executable**: electron-builder's Windows packaging pipeline attempts to run executable-edit/sign steps by default. This configuration sets `win.signAndEditExecutable = false` so packaging works without a code-signing setup. Trade-off: the resulting `.exe` is unsigned, so Windows may warn "Windows protected your PC" (click "More info" → "Run anyway").
- **Cross-compilation**: Windows packaging from Linux/macOS requires Wine. On a native Windows host these steps work without Wine.

#### CMD equivalents

If you use `cmd.exe` instead of PowerShell:

```cmd
set SHIGUANG_WORKSPACE_ROOT=C:\path\to\your\project
npm run desktop:dev
```

With LLM credentials:

```cmd
set SHIGUANG_LLM_API_KEY=sk-...
set SHIGUANG_LLM_MODEL=deepseek-chat
set SHIGUANG_LLM_BASE_URL=https://api.deepseek.com/v1
set SHIGUANG_WORKSPACE_ROOT=C:\path\to\your\project
npm run desktop:dev
```

#### Notes

- `npm run desktop:package` is intentionally Linux-only in this repo now.
- For Windows packaging, use `npm run desktop:package:win`.
- Windows packaging is configured to produce **unsigned** installers (see "Known issues" above). This avoids the winCodeSign/signtool dependency for local builds. To enable signing, provide a code-signing certificate and re-enable `win.signAndEditExecutable` in `package.json`.
- Windows packaging has been fixed to include the compiled core library (`dist/`). Tested to work on Windows 11 x64.

### Environment Configuration

The desktop app reads these environment variables at runtime:

| Variable | Default | Description |
|---|---|---|
| `SHIGUANG_LLM_BASE_URL` | `https://api.openai.com/v1` | Base URL for OpenAI-compatible chat completions endpoint |
| `SHIGUANG_LLM_API_KEY` | *(none)* | API key for the LLM provider. If not set, the app falls back to `RulePlanner` (no LLM required) |
| `SHIGUANG_LLM_MODEL` | `gpt-4o-mini` | Model name to use (e.g. `deepseek-chat`, `gpt-4o`) |
| `SHIGUANG_WORKSPACE_ROOT` | `process.cwd()` | Root directory for `read_text_file` and `search_workspace` tools; all paths are constrained under this root |

Set them before launching the desktop app:
```bash
export SHIGUANG_LLM_API_KEY="sk-..."
export SHIGUANG_LLM_MODEL="deepseek-chat"
export SHIGUANG_LLM_BASE_URL="https://api.deepseek.com/v1"
export SHIGUANG_WORKSPACE_ROOT="/path/to/project"
npm run desktop:dev
```

If `SHIGUANG_LLM_API_KEY` is not set, the app runs entirely locally using the built-in `RulePlanner` with the echo, `read_text_file`, and `search_workspace` tools. No credentials are required. No network calls are made.

## Design

- **Small core, strong boundaries**: orchestration, context, state, and plugins remain separate.
- **Durable by default**: every state transition is persisted.
- **Human steerable**: every run is inspectable, interruptible, and resumable.
- **Tool agnostic**: plugins only know contracts defined in `src/plugins/types.ts`.
- **Context is a product surface**: typed items with provenance, score, and budget.

## Current Status

v0.2.0 — Framework skeleton with real TypeScript contracts, a composition root, SQLite migration strings, an in-memory event sink, a context builder with budget trimming, and a read-only example filesystem plugin.

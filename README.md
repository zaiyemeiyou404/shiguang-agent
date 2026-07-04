# 拾光 (shiguang-agent)

拾光 is a lightweight hybrid agent runtime: part personal workflow agent, part extensible tool orchestrator, and part durable memory layer.

This repo is a **TypeScript framework skeleton** — ready to wire in a model, CLI, or UI. All public contracts and module boundaries are concrete code, not just stubs.

## 模块结构（中文）

> 这一节按“目录是干什么的、关键文件在哪、应该从哪里读起”来写，方便第一次进仓库时快速定位。

```
src/
├── core/        # 核心领域模型：Session / Task / Run / Artifact / Memory / Approval 等基础类型
├── context/     # 上下文构建与压缩：buildContext、prune、digest 压缩、预算裁剪、prompt 渲染
├── brain/       # Agent 决策大脑：planner、loop、workingMemory、validation failure 提炼、LLM prompt 组装
├── tools/       # 工具抽象与内置工具：Tool 接口、注册表、run_validation、write_text_file 等
├── runtime/     # 运行时调度：ActionDispatcher、事件输出、工具调用结果到运行状态的桥接
├── plugins/     # 插件协议层：PluginManifest、PluginRegistry、PluginAdapter 与示例适配器
├── state/       # 持久化层：SQLite schema、各类 repository 接口与 sqlite 实现
├── memory/      # 长期记忆子系统：检索、排序、去重、作用域过滤（workspace/task/global）
├── kernel/      # Kernel 组合根：把 runtime、plugins、repositories 等基础设施装起来
├── app/         # Agent 入口：把 ContextService、Planner、Evaluator、Dispatcher 串成一次完整 run
└── index.ts     # 对外导出
```

### 推荐阅读顺序

如果你想快速理解“用户一句话进来后，系统到底怎么跑”，建议按这个顺序看：

1. `src/app/agent.ts`
   - 总入口。一次 run 从这里开始。
   - 负责加载历史 turn、构建上下文、调用 `runLoop()`。

2. `src/context/service.ts`
   - 上下文装配总入口。
   - 负责：召回记忆 → buildContext → prune → compress → trimToBudget。

3. `src/context/builder.ts`
   - 定义 `stable / volatile / live` 三层上下文。
   - 这里能看到哪些信息会进 prompt，以及预算不足时优先保什么。

4. `src/brain/loop.ts`
   - Agent 主循环。
   - 负责 planner 决策、工具执行、workingMemory 更新、validation 失败线索提炼。

5. `src/brain/openai-model.ts`
   - 把上下文、workingMemory、validation repair guidance 组装成真正发给模型的消息。

---

### 关键目录详解

#### `src/core/`
定义全局通用的数据模型。

重点文件：
- `src/core/types.ts`
  - 定义 `Session`、`Task`、`Run`、`RunEvent`、`Artifact`、`Memory`、`Approval` 等结构。
  - 这是整个仓库的数据地基；很多别的模块都依赖这里的类型。

#### `src/context/`
负责“要把哪些信息喂给模型”。这是上下文工程核心。

重点文件：
- `src/context/service.ts`
  - 上下文主入口。调用顺序就是：
    `memory recall -> buildContext -> prune -> compress -> trimToBudget`
- `src/context/builder.ts`
  - 把输入转成 `ContextBundle`。
  - 其中：
    - `stable`：稳定必须保留的信息（system instruction、task state）
    - `volatile`：本轮易变信息（user turn、recent runs、memory、artifacts）
    - `live`：当前环境引用（workspace file ref）
- `src/context/prune.ts`
  - 去重，防止重复 run summary / memory / artifact 占预算。
- `src/context/compress.ts`
  - 摘要压缩，把多条 `run_summary` / `memory` / `artifact` 合并成 digest。
- `src/context/llm-compactor.ts`
  - LLM 压缩扩展点。当前主要是阈值判断与接口，默认 compactor 是 noop。
- `src/context/render.ts`
  - 把 `ContextBundle` 渲染成最终 prompt 文本。
- `src/context/types.ts`
  - 定义 `ContextItem`、`ContextBundle`、compression 相关类型。

#### `src/brain/`
负责“模型怎么想、怎么决定下一步做什么”。

重点文件：
- `src/brain/types.ts`
  - 定义 `BrainInput`、`BrainAction`、`ActionResult`、`WorkingMemorySnapshot`。
- `src/brain/loop.ts`
  - Agent 主循环。
  - 这里会把工具结果转成 `history` 和 `workingMemory`。
  - validation 失败时，也是在这里提取：
    - failing test
    - suspect file / line
    - `assertExpected / assertActual`
    - `assertDiffSummary`
- `src/brain/planner.ts`
  - 规则 planner 和 LLM planner。
  - 还负责一些自动策略，比如改完文件后自动补跑 validation。
- `src/brain/openai-model.ts`
  - OpenAI-compatible 模型适配层。
  - 会把 `workingMemory.validationFailure` 变成 repair guidance 注入给模型。
- `src/brain/evaluator.ts`
  - 判断循环该继续、停止还是失败。

#### `src/tools/`
工具系统抽象层。

重点文件：
- `src/tools/types.ts`
  - 工具接口、tool descriptor、validation mode 等定义。
- `src/tools/index.ts`
  - 工具导出入口。
- `src/tools/builtins/run-validation.ts`
  - 内置 validation 工具，负责跑 test/typecheck/build 等。
- `src/tools/builtins/write-text-file.ts`
  - 受控文件写入工具。

#### `src/runtime/`
连接 brain 和 tools 的中间层。

重点文件：
- `src/runtime/dispatcher.ts`
  - `ActionDispatcher` 在这里。
  - 负责真正分发 tool call，并把结果标准化成 `ActionResult`。
- `src/runtime/event-sink.ts`
  - 运行期事件输出接口。

#### `src/state/`
持久化层，负责把状态落地到 SQLite。

重点文件：
- `src/state/schema.ts`
  - 所有 SQLite 表结构与 migration 字符串。
- `src/state/repositories.ts`
  - repository 接口定义。
- `src/state/sqlite-memory-repository.ts`
  - memory 的 SQLite 实现。
- `src/state/sqlite-run-repository.ts`
  - run 持久化。
- `src/state/sqlite-approval-repository.ts`
  - approval 持久化。
- `src/state/sqlite-artifact-repository.ts`
  - artifact 持久化。
- `src/state/sqlite-turn-repository.ts`
  - 历史对话 turn 持久化。

#### `src/memory/`
长期记忆系统，负责“记什么、怎么查回来”。

重点文件：
- `src/memory/service.ts`
  - 记忆应用层。
  - 负责 save / search / updateAccess / local index search。
- `src/memory/ranker.ts`
  - 记忆排序器。
  - 现在用的是轻量文本相关度 + salience 排序，不是 embedding。
- `src/memory/types.ts`
  - 记忆查询、排序结果、索引接口定义。

#### `src/app/`
实际 agent 运行入口。

重点文件：
- `src/app/agent.ts`
  - 最值得优先读。
  - 一次用户消息进来后，会从这里开始串起：
    `load turns -> build context -> runLoop -> persist assistant turn`

---

### 两条最重要的源码链

#### 1. 记忆召回链

```txt
userTurn
→ ContextService.build()
→ memoryService.search()
→ sqlite-memory-repository 查询 memories
→ rankMemories 排序
→ 注入 ContextBundle.volatile
```

#### 2. 上下文压缩链

```txt
buildContext
→ pruneContextBundle
→ compressContextBundle
→ shouldUseLlmCompaction
→ trimToBudget
→ renderPrompt
```

如果你只想看这次新加的“记忆 + 上下文压缩”能力，最值得直接打开的文件就是：

- `src/context/service.ts`
- `src/context/builder.ts`
- `src/context/compress.ts`
- `src/memory/service.ts`
- `src/memory/ranker.ts`
- `src/state/sqlite-memory-repository.ts`

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

The desktop app now supports **two configuration modes**:

1. **JSON config file** (recommended for desktop use)
2. **Environment variables** (override the file at runtime)

#### Config file location

- Default: Electron `userData` directory + `shiguang.config.json`
- Windows typically looks like: `%APPDATA%/shiguang-agent/shiguang.config.json`
- macOS typically looks like: `~/Library/Application Support/shiguang-agent/shiguang.config.json`
- Linux typically looks like: `~/.config/shiguang-agent/shiguang.config.json`
- Override path: `SHIGUANG_CONFIG_PATH=/absolute/path/to/shiguang.config.json`

Example file: `examples/shiguang.config.example.json`

Example:

```json
{
  "workspaceRoot": "/absolute/path/to/your/project",
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "maxTokens": 2048
  },
  "providers": {
    "deepseek": {
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "model": "deepseek-chat"
    },
    "openrouter": {
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "model": "deepseek/deepseek-chat"
    },
    "local-ollama-proxy": {
      "baseURL": "http://127.0.0.1:11434/v1",
      "apiKey": "ollama",
      "model": "qwen2.5-coder:14b"
    }
  }
}
```

This is intentionally **Hermes-like**: keep a provider registry, then switch `llm.provider` instead of rewriting the whole runtime every time.

#### Environment variables

The desktop app reads these environment variables at runtime:

| Variable | Default | Description |
|---|---|---|
| `SHIGUANG_LLM_BASE_URL` | `https://api.openai.com/v1` | Base URL for OpenAI-compatible chat completions endpoint |
| `SHIGUANG_LLM_API_KEY` | *(none)* | API key for the LLM provider. If not set, the app falls back to `RulePlanner` (no LLM required) |
| `SHIGUANG_LLM_MODEL` | `gpt-4o-mini` | Model name to use (e.g. `deepseek-chat`, `gpt-4o`) |
| `SHIGUANG_LLM_PROVIDER` | `openai-compatible` | Provider key inside `providers` from the JSON config |
| `SHIGUANG_LLM_MAX_TOKENS` | `2048` | Max completion tokens for the planner call |
| `SHIGUANG_WORKSPACE_ROOT` | `process.cwd()` | Root directory for `read_text_file` and `search_workspace` tools; all paths are constrained under this root |
| `SHIGUANG_CONFIG_PATH` | *(none)* | Absolute path to a custom JSON config file |

Environment variables override the file. Set them before launching the desktop app:
```bash
export SHIGUANG_LLM_API_KEY="sk-..."
export SHIGUANG_LLM_MODEL="deepseek-chat"
export SHIGUANG_LLM_BASE_URL="https://api.deepseek.com/v1"
export SHIGUANG_WORKSPACE_ROOT="/path/to/project"
npm run desktop:dev
```

If `SHIGUANG_LLM_API_KEY` is not set and the selected provider also cannot resolve an API key (for example via `apiKeyEnv`), the app runs entirely locally using the built-in `RulePlanner` with the echo, `read_text_file`, and `search_workspace` tools. No credentials are required. No network calls are made.

#### Adding more Hermes-style choices

Hermes supports many providers because it separates:

- provider identity
- base URL
- API key source
- model name

Shiguang now follows the same minimal pattern for **OpenAI-compatible** backends. To add another provider, add one more entry under `providers`, then switch `llm.provider`.

Example:

```json
{
  "providers": {
    "together": {
      "baseURL": "https://api.together.xyz/v1",
      "apiKeyEnv": "TOGETHER_API_KEY",
      "model": "deepseek-ai/DeepSeek-V3"
    }
  },
  "llm": {
    "provider": "together"
  }
}
```

Current limitation: the planner currently speaks the **OpenAI-compatible chat completions** protocol only. So Hermes-style providers that expose different native APIs (for example non-OpenAI Anthropic direct protocol) still need either:

1. an OpenAI-compatible proxy/base URL, or
2. a new planner/model adapter in code.

## Design

- **Small core, strong boundaries**: orchestration, context, state, and plugins remain separate.
- **Durable by default**: every state transition is persisted.
- **Human steerable**: every run is inspectable, interruptible, and resumable.
- **Tool agnostic**: plugins only know contracts defined in `src/plugins/types.ts`.
- **Context is a product surface**: typed items with provenance, score, and budget.

## Current Status

v0.2.0 — Framework skeleton with real TypeScript contracts, a composition root, SQLite migration strings, an in-memory event sink, a context builder with budget trimming, and a read-only example filesystem plugin.

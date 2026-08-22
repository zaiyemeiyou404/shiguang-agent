# 拾光 Agent

拾光 Agent 是一个轻量级桌面 AI Agent。它把对话、工作区文件操作、工具调用、审批、运行记录和上下文压缩放在一个 Electron 桌面界面里，目标是做成一个下载后即可配置使用的小型个人工作台。

当前版本：`0.2.31`

本版重点：把设置页的“测试连接”从标题栏移到 Provider/API 区域底部，并把连接成功、失败和测试中的反馈改成醒目的状态卡；底部模型切换仍保持“当前会话模型”下拉框，不影响其他会话。

## 下载使用

在 GitHub Releases 页面下载 Windows 版本：

- 安装包：`shiguang-agent-setup-0.2.31.exe`
- 免安装版：`win-unpacked.zip`

安装包安装完成后会创建桌面快捷方式和开始菜单快捷方式。桌面上出现的是快捷方式，不是复制出来的独立 `.exe` 文件。

`main` 分支更新后会自动刷新 `latest` 预发布包，适合想直接试用最新构建的用户。GitHub Releases 页面里带版本号的正式安装包不会自动替换旧 tag；需要推送新的 `v*` tag，例如 `v0.2.31`，才会生成新的正式 Release。

如果使用免安装版，解压后运行：

```text
win-unpacked/拾光 Agent.exe
```

首次启动后，进入左侧或顶部的“设置”，配置模型服务后即可开始新会话。

## 本地数据、记忆和工作区

拾光会把用户数据放在应用目录外，避免重新打包或升级时误删历史。

开发/免安装本地测试版默认目录：

```text
shiguang-agent-data/
  shiguang-state.sqlite          # 会话、run、事件、审批、产物等状态
  shiguang-store.json            # 会话列表和摘要索引
  shiguang.config.json           # provider、模型、MCP、工作区配置
  memory/shiguang-memory.sqlite  # 专门的长期记忆库
  workspace/                     # 默认工作区，工具读写和命令执行都在这里
```

Windows 安装版默认优先使用：

```text
G:\CodexData\shiguang-agent-data\
```

如果没有 `G:` 盘，则回退到安装目录旁边的 `shiguang-agent-data`。本地 `release/win-unpacked` 测试包会优先复用项目根目录的 `shiguang-agent-data`，避免测试包把状态散落到 release 子目录。也可以通过设置页修改工作区，或用环境变量 `SHIGUANG_USER_DATA_DIR` / `SHIGUANG_WORKSPACE_ROOT` 覆盖。

Workspace Policy Registry 会统一决定数据目录、配置文件、状态库、长期记忆库、默认工作区和旧数据迁移来源。Electron 的 `userData`、`shiguang.config.json`、`shiguang-store.json`、`shiguang-state.sqlite`、`memory/shiguang-memory.sqlite` 都从同一个 policy 读取路径，避免“记忆在一个地方、工作区在另一个地方”的散乱问题。

### 默认工作目录和当前会话目录

工作区分两层：

- 默认工作目录：设置页里配置的目录，新会话会从这里开始。
- 当前会话目录：本会话实际执行 `read/search/write/run_terminal_command` 的目录，底部状态栏和工作台状态卡会显示这个路径。

如果默认工作目录是拾光自己的内置 `workspace/`，新会话会自动放进独立的 `.shiguang/sessions/<sessionId>`，避免多个空白会话互相覆盖文件。如果默认工作目录是用户手动选择的真实项目目录，例如 `G:\projects\xxx`，工具会直接在这个项目根目录执行，不再额外套一层 `.shiguang\sessions`。旧版本已经生成的 `项目\.shiguang\sessions\sess_*` 会在打开会话时自动纠正回项目根目录，不会删除旧文件。

从完整“设置”里保存默认工作目录时，如果当前会话还停在旧目录，会同步切到这个目录并刷新详情；聊天框底部的“模型”入口只负责当前会话的 Provider、模型、maxTokens 和 API，不会再修改工作区，也不会把模型切换同步到其他会话。

## 支持的模型服务

桌面端内置了多个 provider 配置入口：

| Provider | 类型 | 默认模型 |
|---|---|---|
| DeepSeek | OpenAI-compatible | `deepseek-v4-flash` |
| OpenAI / Codex API | OpenAI-compatible | `gpt-5` |
| OpenRouter | OpenAI-compatible | `openai/gpt-5` |
| Anthropic | Anthropic Messages API | `claude-3-5-sonnet-latest` |
| Gemini | Gemini API | `gemini-2.5-pro` |
| Ollama | 本地 OpenAI-compatible | `qwen2.5-coder:14b` |

聊天框右下角提供当前会话模型下拉框，会列出已配置 provider 的默认模型和 DeepSeek `Flash` / `Pro` 预设。完整设置用于全局默认工作区和 provider API；底部模型入口只改当前会话，适合不同任务分别使用 DeepSeek、OpenAI、OpenRouter、Ollama 等模型。

DeepSeek 设置页提供 `Flash` / `Pro` 快捷切换，对应官方 API 模型 `deepseek-v4-flash` 和 `deepseek-v4-pro`。旧 `deepseek-chat` / `deepseek-reasoner` 仍可手动填写或通过兼容按钮选择，但建议新配置优先使用 V4 模型名。

Provider Contract Registry 会为每个 provider 统一声明协议、认证方式、请求模式、工具调用能力、JSON 输出能力、usage 能力、本地/远程成本等级和诊断提示。OpenAI-compatible、Anthropic、Gemini、Ollama 都会先进入这层 contract，再由 planner factory 创建具体模型适配器。

API Key 可以在设置里直接填写，也可以通过环境变量提供，例如：

```powershell
$env:DEEPSEEK_API_KEY="你的 key"
$env:OPENAI_API_KEY="你的 key"
$env:ANTHROPIC_API_KEY="你的 key"
$env:GEMINI_API_KEY="你的 key"
```

本项目不会把 API Key 提交到仓库。请不要把真实密钥写入 README、issue、commit 或截图里。

桌面端保存到本机的 API Key 会优先使用 Electron `safeStorage` 加密；旧版本明文配置会在可用时自动迁移到加密字段。

## 能做什么

- 会话管理：新建、切换、重命名、归档会话。
- 桌面 UI：深色工作台界面，接近 Codex/Craft 一类 Agent 产品的布局。
- 工具调用：支持读写文件、搜索工作区、运行终端命令、校验项目等内置工具。
- 扩展工具：支持 GitHub 仓库读取、网页搜索/抓取、轻量代码诊断、后台进程管理和记忆管理。
- 工程理解：支持生成代码地图、搜索符号、分析轻量依赖图，帮助 Agent 更快读懂工程结构。
- 审批机制：高风险工具会进入类似 Codex/Claude 的审查卡片，展示风险等级、影响范围、输入/diff 预览，并按“仅本次通过”恢复运行。
- 运行读条：聊天页顶部显示类似 Codex 的当前动作读条，能看到正在规划、调用工具、等待审批、验证或整理回复。
- 中途补充：Agent 运行中仍可输入补充指令；发送后会先暂停当前 run，再带着补充和已有现场继续推进。
- 暂停继续：运行中不输入内容时，右下角按钮会切换为“暂停”；暂停后可直接点“继续”或补充下一步，避免从零重跑。
- 完成校验：写入/修改文件并通过 `run_validation` 后，会先进入 `completion_check` 判断任务是否已经完成，再输出最终反馈，避免工具一直重复调用。
- 错误诊断：模型请求失败、空响应、HTTP 错误和代理/TLS 问题会显示中文排查建议，方便定位 API Key、Base URL 或网络配置问题。
- 工作区切换：可以在对话中要求切换工作区，也可以通过设置调整。
- 上下文管理：保留关键运行记录，在上下文压力较高时进行压缩。
- 费用治理：模型返回 usage 时会记录本次/累计 token；模型不返回 usage 时会用上下文长度做估算，聊天时间线会显示本步用量和工具 schema 数量。
- 工具省 token：LLM 规划时只发送当前任务最相关的一组工具 schema，工具执行输出进入历史前会自动摘要/截断，避免每一步反复塞入全量工具定义和大段文件内容。
- Tool Contract Registry：每个工具统一声明来源、类别、阶段、风险、审批、成本、前后置建议和完成信号；planner、审批、MCP 适配和事件日志共用这一套规则。
- Provider Contract Registry：每个模型服务统一声明 native tools、JSON mode、system prompt 形态、usage、fallback 请求模式和本地/远程成本等级；例如 Ollama 会直接走 plain JSON，避免多打一次不支持的 native tool/json_object 请求。
- Workspace Policy Registry：统一声明用户数据根目录、配置、状态库、记忆库、默认工作区和旧数据迁移来源；开发版、本地 release 测试包、正式安装包都会走同一套规则。
- 提示词 grounding：系统提示会要求 Agent 区分“用户明确指定的文件”和“从旧上下文推断出的文件”，回答“这个文件/你看到了啥/读了哪个文件”时优先说明证据来源，减少复读旧摘要和乱指代。
- 项目 Agent Profile：工作区可以提供 `.shiguang/agents/default.md`，声明项目级角色、模型偏好、工具白名单和额外规则；运行时会自动注入 profile，并只把允许的工具暴露给 planner。
- 循环防护：连续相同的只读工具动作会自动暂停并说明原因；模型请求数、总 token 和上下文估算 token 都有默认预算，也可通过环境变量调整。
- 自动续跑与费用保护：Agent 每 72 个动作步作为一个内部工作分片；默认只做 1 次保护性自动续跑，仍未形成最终反馈时会暂停并说明最近动作，避免模型/工具循环持续消耗 API 余额。
- 多语言轻量校验：没有 `package.json` 的工作区也能识别并校验常见文件。

当前 `run_validation` 支持：

| 类型 | 行为 |
|---|---|
| Node 项目 | 优先运行 `package.json` 里的 `typecheck`、`test`、`build` 脚本 |
| Python | 读取源码做语法检查，不写 `__pycache__` |
| JavaScript | 使用 Node 做语法检查 |
| JSON | 直接解析 JSON |
| Go | 根目录存在 `go.mod` 时运行 `go test ./...` |
| Rust | 根目录存在 `Cargo.toml` 时运行 `cargo check` |
| 其他常见文件 | 可识别但无校验器时安全跳过，不把任务误判为失败 |

可选费用保护环境变量：

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `SHIGUANG_MAX_MODEL_REQUESTS` | `32` | 单轮最多模型请求次数 |
| `SHIGUANG_MAX_TOTAL_TOKENS` | `180000` | provider 返回 usage 时的单轮累计 token 上限 |
| `SHIGUANG_MAX_PROMPT_ESTIMATE_TOKENS` | `220000` | provider 不返回 usage 时按上下文长度估算的单轮上限 |

新增内置工具：

| 工具 | 用途 |
|---|---|
| `github_repo` | 读取仓库信息、issue、PR、Actions run、latest release |
| `web_search` / `web_fetch` | 搜索网页、抓取网页正文 |
| `collect_diagnostics` | 收集 TypeScript、JavaScript、Python、JSON 诊断 |
| `code_map` / `symbol_search` / `dependency_graph` | 生成工程地图、查找符号、分析 import/use 依赖 |
| `start_background_process` / `stop_background_process` | 启动或停止 dev server 等后台进程，需要审批 |
| `search_memory` / `remember_fact` / `forget_memory` | 搜索、写入、删除本地记忆，删除需要审批 |

### 项目 Agent Profile

拾光现在支持类似 PiAgent 的轻量项目 profile。把 Markdown 文件放到当前工作区：

```text
.shiguang/agents/default.md
```

示例可以参考 `examples/default-agent-profile.md`：

```markdown
---
name: default
description: Conservative project coding profile
model: deepseek-v4-flash
thinking: medium
tools:
  - inspect_project
  - read_text_file
  - search_workspace
  - patch_text_file
  - run_validation
---

Inspect before editing, make the smallest safe change, then validate.
```

启动新 run 时，拾光会自动读取当前工作区的默认 profile：

- `model` 会作为本项目的优先模型。
- `tools` 会作为工具白名单，未列出的工具不会发送给 planner。
- Markdown 正文会作为项目级 system instruction 注入上下文。
- 可通过环境变量 `SHIGUANG_AGENT_PROFILE=reviewer` 选择 `.shiguang/agents/reviewer.md`；找不到时回退到 `default.md`。

### MCP 扩展工具

设置页支持直接编辑 `mcpServers` JSON。配置完成后，新运行会启动 stdio MCP server，通过 `tools/list` 自动发现工具，并把 MCP 工具适配成普通拾光工具继续走统一审批、日志和完成判断。

示例：

```json
{
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "G:/projects"]
  }
}
```

MCP 工具命名会带上 server 前缀，例如 `mcp_filesystem_read_file`。读工具默认无需审批；写入、删除、执行类工具会按风险进入审批。

## 常见问题

### 直接用浏览器打开 Vite 页面为什么不能用？

桌面 UI 依赖 Electron preload bridge，也就是 `window.shiguang`。请使用桌面应用启动，不要直接在 Chrome/Edge 里打开 Vite 页面。

开发模式：

```bash
npm run desktop:dev
```

打包后的应用：

```text
release/win-unpacked/拾光 Agent.exe
```

### 提示缺少 API Key 怎么办？

进入“设置”，选择 provider，填写 API Key、Base URL 和模型名，然后保存。也可以设置对应环境变量后重启应用。

### 文件已经创建了，为什么之前还显示运行失败？

早期版本在文件写入后会自动运行 `run_validation`，而旧逻辑默认读取 `package.json`。如果当前工作区只是一个普通目录，例如只创建了 `hello.py`，就会因为找不到 `package.json` 把任务标成失败。

现在已经改成 fallback validation：没有 `package.json` 时会按文件类型做轻量校验，无法校验的类型会跳过，不再把成功的文件写入误判为失败。

### Windows 提示应用不受信任怎么办？

当前安装包没有代码签名，Windows 可能弹出安全提示。确认来源是本仓库 Release 后，可以选择继续运行。正式公开分发前建议补代码签名。

## 开发

要求：

- Node.js `>=20`
- npm

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

桌面端类型检查：

```bash
npm run desktop:typecheck
```

开发模式启动桌面端：

```bash
npm run desktop:dev
```

打包 Windows 桌面版：

```bash
npm run desktop:package:win
```

输出目录：

```text
release/
├── shiguang-agent-setup-x.y.z.exe
└── win-unpacked/
    └── 拾光 Agent.exe
```

## 项目结构

```text
electron/          Electron 主进程、preload、IPC、桌面服务
ui/                React + Vite 桌面界面
src/               Agent 核心：上下文、planner、tools、runtime、state、memory
docs/              架构和开发文档
examples/          示例配置
.github/workflows/ GitHub Actions 打包发布流程
```

## 发布

本仓库包含 GitHub Actions workflow：`.github/workflows/desktop-release.yml`。

推送 tag 后会自动构建 Release：

```bash
git tag v0.2.31
git push origin v0.2.31
```

Release 会上传：

- Windows 安装包 `.exe`
- Windows 免安装包 `win-unpacked.zip`

## 当前状态

这是一个可运行的早期桌面 Agent 产品原型。核心文件工具、模型 provider、审批流、上下文压缩和桌面打包已经接通，但仍建议在公开大范围使用前继续完善：

- 增加正式应用图标和代码签名。
- 增加更完整的首次启动引导。
- 增加更多工具卡片和运行过程可视化。
- 增加自动更新能力。
- 明确开源许可证。

## 工具协议和 MCP

拾光 Agent 使用两层工具标准：

- `shiguang.tool.v1`：面向 prompt/native tool description 的兼容协议，描述工具来源、类别、阶段、风险、审批策略和推荐后续工具。
- `shiguang.tool.contract.v1`：面向 runtime 的 Tool Contract Registry，统一声明工具成本、前置建议、后置建议、完成信号和 effects。planner、审批、事件日志和 MCP 适配都会复用同一份 contract。

MCP 会被当作外部能力接入层，而不是另一套 Agent 循环。MCP tool 接入后应适配成普通 `ToolDescriptor`，继续走同一个 `ToolRegistry`、审批策略、dispatcher、事件日志和完成判断。

详细设计见：

```text
docs/tool-protocol.md
```

## 模型 Provider Contract

拾光 Agent 也新增了 `shiguang.provider.contract.v1`。它会在创建具体模型适配器前，统一描述 provider 的协议、认证方式、native tool 能力、JSON mode 能力、system prompt 形态、usage 能力、fallback 请求模式和成本等级。

详细设计见：

```text
docs/provider-contract.md
```

## 工作区 Workspace Policy

拾光 Agent 使用 `shiguang.workspace.policy.v1` 统一决定用户数据目录、配置文件、状态库、长期记忆库、默认工作区和旧数据迁移来源。Electron `userData`、设置页、会话缓存、SQLite 状态和记忆库都从这层 policy 读取路径。

详细设计见：

```text
docs/workspace-policy.md
```

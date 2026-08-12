# 拾光 Agent

拾光 Agent 是一个轻量级桌面 AI Agent。它把对话、工作区文件操作、工具调用、审批、运行记录和上下文压缩放在一个 Electron 桌面界面里，目标是做成一个下载后即可配置使用的小型个人工作台。

当前版本：`0.2.5`

## 下载使用

在 GitHub Releases 页面下载 Windows 版本：

- 安装包：`拾光 Agent Setup 0.2.5.exe`
- 免安装版：`win-unpacked.zip`

`main` 分支更新后会自动刷新 `latest` 预发布包，适合想直接试用最新构建的用户。GitHub Releases 页面里带版本号的正式安装包不会自动替换旧 tag；需要推送新的 `v*` tag，例如 `v0.2.5`，才会生成新的正式 Release。

如果使用免安装版，解压后运行：

```text
win-unpacked/拾光 Agent.exe
```

首次启动后，进入左侧或顶部的“设置”，配置模型服务后即可开始新会话。

## 支持的模型服务

桌面端内置了多个 provider 配置入口：

| Provider | 类型 | 默认模型 |
|---|---|---|
| DeepSeek | OpenAI-compatible | `deepseek-chat` |
| OpenAI / Codex API | OpenAI-compatible | `gpt-5` |
| OpenRouter | OpenAI-compatible | `openai/gpt-5` |
| Anthropic | Anthropic Messages API | `claude-3-5-sonnet-latest` |
| Gemini | Gemini API | `gemini-2.5-pro` |
| Ollama | 本地 OpenAI-compatible | `qwen2.5-coder:14b` |

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
- 运行读条：运行区显示类似 Codex 的当前步骤读条，能看到正在规划、调用工具、等待审批或整理回复。
- 中途补充：Agent 运行中仍可输入补充指令；发送后会先暂停当前 run，再带着补充和已有现场继续推进。
- 暂停继续：运行中不输入内容时，右下角按钮会切换为“暂停”；暂停后可直接点“继续”或补充下一步，避免从零重跑。
- 工作区切换：可以在对话中要求切换工作区，也可以通过设置调整。
- 上下文管理：保留关键运行记录，在上下文压力较高时进行压缩。
- 检查点续跑：普通运行预算提升到 36 步；如果大工程分析仍达到预算上限，会显示“待继续”并保留现场，而不是误标成“已完成”。
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

新增内置工具：

| 工具 | 用途 |
|---|---|
| `github_repo` | 读取仓库信息、issue、PR、Actions run、latest release |
| `web_search` / `web_fetch` | 搜索网页、抓取网页正文 |
| `collect_diagnostics` | 收集 TypeScript、JavaScript、Python、JSON 诊断 |
| `code_map` / `symbol_search` / `dependency_graph` | 生成工程地图、查找符号、分析 import/use 依赖 |
| `start_background_process` / `stop_background_process` | 启动或停止 dev server 等后台进程，需要审批 |
| `search_memory` / `remember_fact` / `forget_memory` | 搜索、写入、删除本地记忆，删除需要审批 |

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
├── 拾光 Agent Setup 0.2.5.exe
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
git tag v0.2.5
git push origin v0.2.5
```

Release 会上传：

- Windows 安装包 `.exe`
- Windows 免安装包 `win-unpacked.zip`
- Linux 免安装包 `linux-unpacked.zip`

## 当前状态

这是一个可运行的早期桌面 Agent 产品原型。核心文件工具、模型 provider、审批流、上下文压缩和桌面打包已经接通，但仍建议在公开大范围使用前继续完善：

- 增加正式应用图标和代码签名。
- 增加更完整的首次启动引导。
- 增加更多工具卡片和运行过程可视化。
- 增加自动更新能力。
- 明确开源许可证。

## 工具协议和 MCP

拾光 Agent 已新增内部工具协议 `shiguang.tool.v1`，会把每个工具统一标记为来源、类别、阶段、风险、审批策略和推荐后续工具。

MCP 会被当作外部能力接入层，而不是另一套 Agent 循环。MCP tool 接入后应适配成普通 `ToolDescriptor`，继续走同一个 `ToolRegistry`、审批策略、dispatcher、事件日志和完成判断。

详细设计见：

```text
docs/tool-protocol.md
```

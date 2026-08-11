# Shiguang Tool Protocol and MCP

This document defines how Shiguang Agent treats tools and how MCP fits into that system.

## Core idea

Shiguang has one internal tool pipeline:

```text
model decision -> ToolRegistry -> approval policy -> dispatcher -> tool result -> completion check
```

Native tools and MCP tools should both enter this same pipeline. MCP is not a second agent loop. It is an external capability connector that can provide tools, resources, and prompts.

Official MCP docs describe the three server primitives this way:

- Tools are model-controlled executable functions.
- Resources are application-controlled context/data sources.
- Prompts are user-controlled reusable templates.

Sources:

- https://modelcontextprotocol.io/docs/learn/server-concepts
- https://modelcontextprotocol.io/specification/2025-06-18/server/index
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## Tool protocol v1

Every tool is described with the same metadata:

| Field | Purpose |
|---|---|
| `version` | Current protocol version, `shiguang.tool.v1` |
| `source` | `native` or `mcp-adapter` |
| `category` | Domain such as `filesystem`, `code`, `web`, `memory`, or `mcp` |
| `phase` | Intended loop phase: `inspect`, `read`, `edit`, `execute`, `verify`, or `summarize` |
| `risk` | Runtime risk: `read`, `write`, or `execute` |
| `approval` | Approval policy hint: `never`, `on_risk`, or `always` |
| `recommendedNextTools` | Tool names that commonly make sense after a successful result |

The implementation lives in:

- `src/tools/protocol.ts`

The protocol is used in:

- `src/brain/prompt-builder.ts`
- `src/brain/providers/openai-compatible.ts`

## Standard action flow

For coding and workspace tasks, the model should follow this loop:

```text
inspect/read/map -> edit/execute -> verify -> summarize
```

Examples:

- Unknown repo: `inspect_project` -> `code_map` -> `symbol_search` / `dependency_graph` -> `read_text_file`.
- File mutation: `write_text_file` / `patch_text_file` -> `run_validation` / `collect_diagnostics` -> final feedback.
- Web research: `web_search` -> `web_fetch` -> summarize with source context.
- Background process: `start_background_process` -> `read_background_process` -> `stop_background_process` when needed.

The model should stop once the user's requested outcome is complete. A successful write followed by successful validation should produce final feedback, not another equivalent tool call.

## MCP relationship

MCP servers expose capabilities through protocol methods such as `tools/list` and `tools/call`. Shiguang adapts those tool definitions into native `ToolDescriptor` objects:

```text
MCP server tool -> McpToolAdapter -> ToolDescriptor -> ToolRegistry
```

The adapter implementation lives in:

- `src/tools/mcp-adapter.ts`
- `src/tools/mcp-stdio-runtime.ts`

An MCP tool becomes a normal Shiguang tool:

```ts
{
  name: "mcp_github_create_issue",
  capability: "mcp.github.create_issue",
  risk: "write",
  requiresApproval: true
}
```

After adaptation, it uses the same approval cards, duplicate mutation checks, dispatcher, event log, and completion checks as built-in tools.

## What MCP resources and prompts should do

Resources should not be treated as executable tools by default. They are context inputs the app can read and decide whether to attach to the model.

Prompts should not be auto-run by the model. They are user-invoked templates, similar to slash commands or workflow presets.

Tools are the only MCP primitive that the model should select and execute autonomously, and even then Shiguang's approval policy can pause risky actions before execution.

## Configuring MCP servers

The desktop app supports stdio MCP servers through `mcpServers` in `shiguang.config.json` or through the settings drawer JSON editor:

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "G:/projects"]
    }
  }
}
```

On each new run, Shiguang starts the configured server, calls `tools/list`, adapts each returned tool into a native `ToolDescriptor`, and then calls `tools/call` when the model selects that tool.

## Remaining MCP work

The current runtime supports stdio tools. The next product steps are:

- Add explicit MCP health checks in the settings UI.
- Add Streamable HTTP transport.
- Add `resources/list` and `resources/read` support for attachable context.
- Add richer audit details for every MCP call.

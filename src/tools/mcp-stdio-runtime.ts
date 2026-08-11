import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Tool, ToolExecutionContext, ToolRisk } from "./types.js";
import {
  createMcpToolAdapter,
  type McpToolClient,
  type McpToolCallContext,
  type McpToolDefinition,
} from "./mcp-adapter.js";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const FALLBACK_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TOOL_LIST_PAGES = 20;
const MAX_STDERR_CHARS = 16_000;

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

export interface McpStdioServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpRuntimeClientInfo {
  name: string;
  version: string;
}

export interface McpStdioRuntimeOptions {
  discoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
  clientInfo?: McpRuntimeClientInfo;
  logger?: (message: string) => void;
}

interface ListedMcpTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
}

interface McpToolsListResult {
  tools?: unknown;
  nextCursor?: unknown;
}

export class McpJsonRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "McpJsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export class McpStdioMessageFramer {
  private buffer = "";

  push(chunk: Buffer | string): JsonRpcMessage[] {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;

      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!rawLine) continue;

      const parsed = JSON.parse(rawLine) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isJsonRpcMessage(item)) messages.push(item);
        }
      } else if (isJsonRpcMessage(parsed)) {
        messages.push(parsed);
      }
    }

    return messages;
  }
}

export class McpStdioClient {
  private readonly config: McpStdioServerConfig;
  private readonly options: Required<Pick<McpStdioRuntimeOptions, "discoveryTimeoutMs" | "requestTimeoutMs" | "clientInfo">>
    & Pick<McpStdioRuntimeOptions, "logger">;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly framer = new McpStdioMessageFramer();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextRequestId = 1;
  private protocolVersion = DEFAULT_PROTOCOL_VERSION;
  private initialized = false;
  private stderrTail = "";

  constructor(config: McpStdioServerConfig, options: McpStdioRuntimeOptions = {}) {
    this.config = config;
    this.options = {
      discoveryTimeoutMs: options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      clientInfo: options.clientInfo ?? { name: "shiguang-agent", version: "0.2.1" },
      logger: options.logger,
    };
  }

  async listTools(context?: ToolExecutionContext): Promise<ListedMcpTool[]> {
    await this.start(context);

    const tools: ListedMcpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = await this.request("tools/list", {
        ...(cursor ? { cursor } : {}),
        _meta: this.requestMeta(),
      }, {
        timeoutMs: this.options.discoveryTimeoutMs,
        signal: context?.signal,
      }) as McpToolsListResult;

      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (isObject(tool)) tools.push(tool as ListedMcpTool);
        }
      }

      cursor = typeof result.nextCursor === "string" && result.nextCursor.trim()
        ? result.nextCursor
        : undefined;
      if (!cursor) break;
    }

    return tools;
  }

  async callTool(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<unknown> {
    await this.start(context);
    return this.request("tools/call", {
      name: toolName,
      arguments: isObject(input) ? input : {},
      _meta: this.requestMeta(),
    }, {
      timeoutMs: this.options.requestTimeoutMs,
      signal: context?.signal,
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, pending, new Error(`MCP server ${this.config.id} was closed.`));
    }
    if (!child) return;
    child.kill();
  }

  private async start(context?: ToolExecutionContext): Promise<void> {
    if (this.initialized && this.child && !this.child.killed) return;
    if (!this.child || this.child.killed) {
      this.spawnServer();
    }

    try {
      const result = await this.request("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.options.clientInfo,
      }, {
        timeoutMs: this.options.discoveryTimeoutMs,
        signal: context?.signal,
      });
      if (isObject(result) && typeof result.protocolVersion === "string") {
        this.protocolVersion = result.protocolVersion;
      }
      this.notify("notifications/initialized", {});
    } catch (error) {
      if (!isMethodNotFoundError(error)) {
        throw error;
      }
      // MCP 2026-07-28 removed the initialize handshake. Keep going with per-request metadata.
      this.protocolVersion = FALLBACK_PROTOCOL_VERSION;
    }

    this.initialized = true;
  }

  private spawnServer(): void {
    this.log(`Starting MCP server ${this.config.id}: ${this.config.command} ${(this.config.args ?? []).join(" ")}`.trim());
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
      },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      let messages: JsonRpcMessage[];
      try {
        messages = this.framer.push(chunk);
      } catch (error) {
        this.log(`Invalid MCP stdout from ${this.config.id}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      for (const message of messages) {
        this.handleMessage(message);
      }
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail += chunk.toString("utf8");
      if (this.stderrTail.length > MAX_STDERR_CHARS) {
        this.stderrTail = this.stderrTail.slice(-MAX_STDERR_CHARS);
      }
    });

    this.child.on("error", (error) => {
      this.rejectAllPending(new Error(`MCP server ${this.config.id} failed to start: ${error.message}`));
    });

    this.child.on("exit", (code, signal) => {
      const suffix = this.stderrTail.trim() ? ` stderr: ${this.stderrTail.trim().slice(-800)}` : "";
      this.rejectAllPending(new Error(`MCP server ${this.config.id} exited (${signal ?? code ?? "unknown"}).${suffix}`));
      this.child = null;
      this.initialized = false;
    });
  }

  private request(method: string, params: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error(`MCP server ${this.config.id} is not running.`));
    }

    const id = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.signal?.removeEventListener("abort", pending.abortHandler ?? (() => undefined));
        reject(new Error(`MCP request timed out: ${this.config.id}.${method}`));
      }, options.timeoutMs);

      const abortHandler = options.signal
        ? () => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            this.notify("notifications/cancelled", {
              requestId: id,
              reason: "Client aborted the MCP request.",
            });
            reject(new Error(`MCP request aborted: ${this.config.id}.${method}`));
          }
        : undefined;

      if (options.signal?.aborted) {
        clearTimeout(timer);
        reject(new Error(`MCP request aborted before send: ${this.config.id}.${method}`));
        return;
      }

      if (options.signal && abortHandler) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        abortHandler,
        signal: options.signal,
      });

      this.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin.writable) return;
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        this.rejectPending(
          message.id,
          pending,
          new McpJsonRpcError(
            message.error.message ?? `MCP request failed: ${pending.method}`,
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        this.resolvePending(message.id, pending, message.result);
      }
      return;
    }

    if ("id" in message && "method" in message) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Shiguang Agent does not implement MCP client method: ${message.method}`,
        },
      });
    }
  }

  private resolvePending(id: JsonRpcId, pending: PendingRequest, result: unknown): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abortHandler ?? (() => undefined));
    pending.resolve(result);
  }

  private rejectPending(id: JsonRpcId, pending: PendingRequest, error: Error): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abortHandler ?? (() => undefined));
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.rejectPending(id, pending, error);
    }
  }

  private requestMeta(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
      "io.modelcontextprotocol/clientInfo": this.options.clientInfo,
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  private log(message: string): void {
    this.options.logger?.(message);
  }
}

export class McpStdioToolRuntime implements McpToolClient {
  private readonly configs: Map<string, McpStdioServerConfig>;
  private readonly clients = new Map<string, McpStdioClient>();
  private readonly options: McpStdioRuntimeOptions;

  constructor(configs: McpStdioServerConfig[], options: McpStdioRuntimeOptions = {}) {
    this.configs = new Map(
      configs
        .filter((config) => !config.disabled && config.id.trim() && config.command.trim())
        .map((config) => [config.id, config]),
    );
    this.options = options;
  }

  async discoverTools(context?: ToolExecutionContext): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const config of this.configs.values()) {
      try {
        const client = this.getClient(config);
        const listedTools = await client.listTools(context);
        tools.push(...createMcpToolAdaptersFromListedTools(config.id, listedTools, this));
      } catch (error) {
        this.options.logger?.(
          `MCP discovery failed for ${config.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return tools;
  }

  async callTool(serverId: string, toolName: string, input: unknown, context?: McpToolCallContext): Promise<unknown> {
    const config = this.configs.get(serverId);
    if (!config) {
      throw new Error(`MCP server is not configured: ${serverId}`);
    }
    return this.getClient(config).callTool(toolName, input, context);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }

  private getClient(config: McpStdioServerConfig): McpStdioClient {
    const existing = this.clients.get(config.id);
    if (existing) return existing;
    const client = new McpStdioClient(config, this.options);
    this.clients.set(config.id, client);
    return client;
  }
}

export function createMcpToolAdaptersFromListedTools(
  serverId: string,
  listedTools: ListedMcpTool[],
  client: McpToolClient,
): Tool[] {
  return listedTools
    .filter((tool): tool is ListedMcpTool & { name: string } => typeof tool.name === "string" && tool.name.trim().length > 0)
    .map((tool) => createMcpToolAdapter(toMcpToolDefinition(serverId, tool), client));
}

export function toMcpToolDefinition(serverId: string, tool: ListedMcpTool & { name: string }): McpToolDefinition {
  const risk = inferMcpToolRisk(tool);
  const title = typeof tool.title === "string" && tool.title.trim() ? tool.title.trim() : "";
  const description = typeof tool.description === "string" && tool.description.trim() ? tool.description.trim() : "";
  return {
    serverId,
    name: tool.name,
    description: [title, description].filter(Boolean).join(" - ") || tool.name,
    inputSchema: isObject(tool.inputSchema) ? tool.inputSchema : emptyObjectSchema(),
    risk,
    requiresApproval: risk !== "read",
    capability: `mcp.${serverId}.${tool.name}`,
  };
}

export function inferMcpToolRisk(tool: ListedMcpTool): ToolRisk {
  const annotations = isObject(tool.annotations) ? tool.annotations : {};
  if (annotations.destructiveHint === true) return "write";
  if (annotations.readOnlyHint === true) return "read";

  const name = typeof tool.name === "string" ? tool.name.toLowerCase() : "";
  if (/(^|[_-])(run|exec|execute|shell|terminal|command|spawn|process)([_-]|$)/.test(name)) return "execute";
  if (/(write|create|update|delete|remove|move|patch|edit|insert|upsert|publish|deploy|send|post)/.test(name)) {
    return "write";
  }
  return "read";
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isObject(value) || value.jsonrpc !== "2.0") return false;
  if ("id" in value && ("result" in value || "error" in value)) return true;
  return typeof value.method === "string";
}

function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof McpJsonRpcError && error.code === -32601;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

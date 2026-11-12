import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { campusCardFromOutput, renderCardText, XDYOU_CARD_URI, type CampusCard } from "./xdyou-board.js";
import { readXdyouBoardHtml } from "./xdyou-board-server.js";
import { xdyouPlugin } from "./xdyou-plugin.js";

const PROTOCOL_VERSION = "2025-06-18";
const SESSION_TOOLS = new Set(["login", "card", "loans", "schoolnet", "forum", "sport", "sportclass", "attendance", "meters", "water"]);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export function xdyouMcpCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./xdyou-mcp.js", import.meta.url))],
  };
}

export function xdyouMcpTools(): Array<Record<string, unknown>> {
  return xdyouPlugin.manifest.capabilities.map((capability) => ({
    name: capability.id,
    title: `XDYou ${capability.id}`,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: {
      readOnlyHint: !SESSION_TOOLS.has(capability.id),
      destructiveHint: false,
      openWorldHint: SESSION_TOOLS.has(capability.id),
    },
    _meta: {
      "ui/resourceUri": XDYOU_CARD_URI,
      "openai/outputTemplate": XDYOU_CARD_URI,
    },
  }));
}

export async function handleXdyouMcpMessage(message: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  if (typeof message.method !== "string") {
    return rpcError(message.id ?? null, -32600, "Invalid request");
  }
  if (message.id === undefined) return null;

  try {
    const result = await dispatch(message.method, message.params);
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    const coded = error instanceof McpDispatchError ? error : new McpDispatchError(-32603, error instanceof Error ? error.message : String(error));
    return rpcError(message.id, coded.code, coded.message);
  }
}

export function startXdyouMcpServer(): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void respond(trimmed);
  });
  input.on("close", () => {
    process.exit(0);
  });
}

class McpDispatchError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  if (method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: { name: "xdyou", version: xdyouPlugin.manifest.version },
      instructions: "XDYou campus data for 西电. Call login when the user wants to 登录 or 同步. Do not ask for or store the password. Each tool returns one generic card. The text ends with a local card link, structuredContent.card is the same card, and ui://xdyou/card.html is the MCP App. Hosts that support MCP Apps or an OpenAI output template draw that HTML. DeepSeek Harness embeds the same link. When the user asks to 画图 or 画课表, call the tool again and stop. Do not write a script or generate a PNG. Do not expect a Shiguang-specific panel.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: xdyouMcpTools() };
  if (method === "resources/list") return { resources: xdyouCardResource() };
  if (method === "resources/read") return readXdyouCardResource(params);
  if (method === "tools/call") return callTool(params);
  throw new McpDispatchError(-32601, `Method not found: ${method}`);
}

async function callTool(params: unknown): Promise<Record<string, unknown>> {
  const request = params && typeof params === "object" ? params as Record<string, unknown> : {};
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (!xdyouPlugin.manifest.capabilities.some((capability) => capability.id === name)) {
    throw new McpDispatchError(-32602, `Unknown XDYou tool: ${name || "(missing)"}`);
  }
  const result = await xdyouPlugin.execute({
    pluginId: xdyouPlugin.manifest.pluginId,
    capability: name,
    input: request.arguments && typeof request.arguments === "object" ? request.arguments : {},
  });
  const output = result.output ?? { ok: false, error: result.error };
  const record = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : { ok: false, error: result.error };
  const cardUrl = typeof record.cardUrl === "string" ? record.cardUrl : undefined;
  const text = renderCardText(cardFromOutput(name, record), cardUrl);
  return {
    content: [{ type: "text", text }],
    structuredContent: output,
    isError: result.output == null,
  };
}

function xdyouCardResource(): Array<Record<string, unknown>> {
  return [{
    uri: XDYOU_CARD_URI,
    name: "xdyou-card",
    title: "西电卡片",
    mimeType: "text/html;profile=mcp-app",
    description: "Generic campus card for the latest XDYou tool result.",
  }];
}

function readXdyouCardResource(params: unknown): Record<string, unknown> {
  const uri = params && typeof params === "object" && typeof (params as { uri?: unknown }).uri === "string"
    ? (params as { uri: string }).uri
    : XDYOU_CARD_URI;
  if (uri !== XDYOU_CARD_URI) throw new McpDispatchError(-32002, `Unknown resource: ${uri}`);
  return { contents: [{ uri: XDYOU_CARD_URI, mimeType: "text/html;profile=mcp-app", text: readXdyouBoardHtml() }] };
}

function cardFromOutput(dataset: string, output: Record<string, unknown>): CampusCard {
  const card = output.card;
  if (card && typeof card === "object" && !Array.isArray(card) && typeof (card as CampusCard).title === "string" && typeof (card as CampusCard).kind === "string") {
    return card as CampusCard;
  }
  return campusCardFromOutput(dataset, dataset, output);
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function respond(line: string): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(line) as JsonRpcRequest;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const response = await handleXdyouMcpMessage(message);
  if (response) write(response);
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
}

if (isDirectRun()) startXdyouMcpServer();

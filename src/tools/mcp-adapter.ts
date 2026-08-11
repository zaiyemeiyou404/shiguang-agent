import type { Tool, ToolDescriptor, ToolExecutionContext, ToolRisk } from "./types.js";

export interface McpToolDefinition {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  risk?: ToolRisk;
  requiresApproval?: boolean;
  capability?: string;
}

export interface McpToolCallContext extends ToolExecutionContext {
  serverId: string;
  toolName: string;
}

export interface McpToolClient {
  callTool(serverId: string, toolName: string, input: unknown, context?: McpToolCallContext): Promise<unknown>;
}

export function createMcpToolAdapter(definition: McpToolDefinition, client: McpToolClient): Tool {
  const descriptor = createMcpToolDescriptor(definition);

  return {
    descriptor,
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      return client.callTool(definition.serverId, definition.name, input, {
        ...context,
        serverId: definition.serverId,
        toolName: definition.name,
      });
    },
  };
}

export function createMcpToolDescriptor(definition: McpToolDefinition): ToolDescriptor {
  const risk = definition.risk ?? "read";
  return {
    name: normalizeMcpToolName(definition.serverId, definition.name),
    description: definition.description
      ? `[MCP:${definition.serverId}] ${definition.description}`
      : `[MCP:${definition.serverId}] ${definition.name}`,
    inputSchema: definition.inputSchema ?? emptyObjectSchema(),
    risk,
    requiresApproval: definition.requiresApproval ?? risk !== "read",
    capability: definition.capability ?? `mcp.${definition.serverId}.${definition.name}`,
  };
}

export function normalizeMcpToolName(serverId: string, toolName: string): string {
  const normalizedServer = normalizeNamePart(serverId);
  const normalizedTool = normalizeNamePart(toolName);
  const combined = `mcp_${normalizedServer}_${normalizedTool}`.slice(0, 64);
  return combined || "mcp_tool";
}

function normalizeNamePart(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "unknown";
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

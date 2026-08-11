import type { ToolDescriptor, ToolRisk } from "./types.js";

export const TOOL_PROTOCOL_VERSION = "shiguang.tool.v1" as const;

export type ToolProtocolVersion = typeof TOOL_PROTOCOL_VERSION;

export type ToolProtocolSource = "native" | "mcp-adapter";

export type ToolProtocolCategory =
  | "filesystem"
  | "workspace"
  | "code"
  | "diagnostics"
  | "process"
  | "git"
  | "github"
  | "web"
  | "memory"
  | "system"
  | "mcp";

export type ToolProtocolPhase =
  | "inspect"
  | "read"
  | "plan"
  | "edit"
  | "execute"
  | "verify"
  | "summarize";

export type ToolApprovalMode = "never" | "on_risk" | "always";

export interface ToolProtocolMetadata {
  version: ToolProtocolVersion;
  source: ToolProtocolSource;
  category: ToolProtocolCategory;
  phase: ToolProtocolPhase;
  risk: ToolRisk;
  approval: ToolApprovalMode;
  recommendedNextTools: string[];
}

export interface ToolResultEnvelope<T = unknown> {
  protocolVersion: ToolProtocolVersion;
  toolName: string;
  ok: boolean;
  output?: T;
  error?: string;
  summary?: string;
}

export function inferToolProtocol(tool: ToolDescriptor): ToolProtocolMetadata {
  const capability = tool.capability ?? tool.name;
  const category = inferCategory(capability, tool.name);
  const risk = tool.risk ?? inferRisk(capability, tool.effects?.workspaceMutation === true);
  const phase = inferPhase(capability, tool.name, tool.effects?.workspaceMutation === true, risk);

  return {
    version: TOOL_PROTOCOL_VERSION,
    source: category === "mcp" || capability.startsWith("mcp.") ? "mcp-adapter" : "native",
    category,
    phase,
    risk,
    approval: inferApprovalMode(tool.requiresApproval === true, risk),
    recommendedNextTools: inferRecommendedNextTools(tool.name, capability, phase),
  };
}

export function describeToolForPrompt(tool: ToolDescriptor): string {
  const protocol = inferToolProtocol(tool);
  const effects = tool.effects
    ? ` effects: workspaceMutation=${tool.effects.workspaceMutation === true}, validationMode=${tool.effects.validationMode ?? "none"}`
    : "";
  const recommendations = protocol.recommendedNextTools.length > 0
    ? ` next=${protocol.recommendedNextTools.join(",")}`
    : "";
  const approval = tool.requiresApproval ? " requiresApproval=true" : "";
  return [
    `- ${tool.name}: ${tool.description}`,
    `(protocol=${protocol.version}; source=${protocol.source}; category=${protocol.category}; phase=${protocol.phase}; risk=${protocol.risk}; approval=${protocol.approval}${recommendations})`,
    `(input schema: ${JSON.stringify(tool.inputSchema)})${effects}${approval}`,
  ].join(" ");
}

export function describeToolForNativeFunction(tool: ToolDescriptor): string {
  const protocol = inferToolProtocol(tool);
  const effects = tool.effects
    ? ` Effects: workspaceMutation=${tool.effects.workspaceMutation === true}, validationMode=${tool.effects.validationMode ?? "none"}.`
    : "";
  const approval = tool.requiresApproval ? " Runtime policy may pause this tool call for user approval." : "";
  const next = protocol.recommendedNextTools.length > 0
    ? ` Recommended next tools after useful output: ${protocol.recommendedNextTools.join(", ")}.`
    : "";
  return [
    tool.description,
    `Tool protocol: ${protocol.version}; source=${protocol.source}; category=${protocol.category}; phase=${protocol.phase}; risk=${protocol.risk}; approval=${protocol.approval}.`,
    effects,
    next,
    approval,
  ].join(" ").replace(/\s+/g, " ").trim().slice(0, 1024);
}

function inferCategory(capability: string, name: string): ToolProtocolCategory {
  const key = `${capability} ${name}`;
  if (capability.startsWith("mcp.") || name.startsWith("mcp_")) return "mcp";
  if (capability.startsWith("fs.") || /file|directory|path|workspace/i.test(name)) return "filesystem";
  if (capability.startsWith("project.")) return "workspace";
  if (capability.startsWith("code.")) return "code";
  if (capability.startsWith("diagnostics.")) return "diagnostics";
  if (capability.startsWith("process.")) return "process";
  if (capability.startsWith("git.")) return "git";
  if (capability.startsWith("github.")) return "github";
  if (capability.startsWith("web.")) return "web";
  if (capability.startsWith("memory.")) return "memory";
  if (/validation|diagnostic/i.test(key)) return "diagnostics";
  if (/terminal|process|command/i.test(key)) return "process";
  return "system";
}

function inferPhase(capability: string, name: string, mutatesWorkspace: boolean, risk: ToolRisk): ToolProtocolPhase {
  const key = `${capability} ${name}`;
  if (risk === "write") return "edit";
  if (risk === "execute") return "execute";
  if (mutatesWorkspace || /\.(write|patch|copy|move|delete)$/i.test(capability)) return "edit";
  if (/validate|diagnostic|check|test/i.test(key)) return "verify";
  if (/start|stop|run|exec|command|process/i.test(key)) return "execute";
  if (/map|inspect|stat|list|search|dependency|symbol/i.test(key)) return "inspect";
  if (/read|fetch|github|web|memory/i.test(key)) return "read";
  return "plan";
}

function inferRisk(capability: string, mutatesWorkspace: boolean): ToolRisk {
  if (mutatesWorkspace) return "write";
  if (/\.(write|patch|copy|move|delete)$/i.test(capability)) return "write";
  if (/process\.|exec|run|start|stop/i.test(capability)) return "execute";
  return "read";
}

function inferApprovalMode(requiresApproval: boolean, risk: ToolRisk): ToolApprovalMode {
  if (requiresApproval) return "always";
  return risk === "read" ? "never" : "on_risk";
}

function inferRecommendedNextTools(name: string, capability: string, phase: ToolProtocolPhase): string[] {
  if (name === "inspect_project" || capability === "project.inspect") {
    return ["code_map", "dependency_graph", "collect_diagnostics"];
  }
  if (name === "code_map" || capability === "code.map") {
    return ["symbol_search", "dependency_graph", "read_text_file"];
  }
  if (name === "symbol_search" || capability === "code.symbols") {
    return ["read_text_file"];
  }
  if (name === "dependency_graph" || capability === "code.dependencies") {
    return ["read_text_file", "collect_diagnostics"];
  }
  if (name === "web_search" || capability === "web.search") {
    return ["web_fetch"];
  }
  if (name === "start_background_process" || capability === "process.background.start") {
    return ["read_background_process", "stop_background_process"];
  }
  if (phase === "edit") {
    return ["run_validation", "collect_diagnostics"];
  }
  if (phase === "verify") {
    return ["finish"];
  }
  return [];
}

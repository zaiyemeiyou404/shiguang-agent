import type {
  ToolApprovalMode,
  ToolContractCategory,
  ToolContractPhase,
  ToolContractSource,
  ToolDescriptor,
  ToolRisk,
} from "./types.js";
import { describeToolContract, inferToolContract } from "./contract.js";

export const TOOL_PROTOCOL_VERSION = "shiguang.tool.v1" as const;

export type ToolProtocolVersion = typeof TOOL_PROTOCOL_VERSION;
export type ToolProtocolSource = ToolContractSource;
export type ToolProtocolCategory = ToolContractCategory;
export type ToolProtocolPhase = ToolContractPhase;
export type { ToolApprovalMode } from "./types.js";

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
  const contract = tool.contract ?? inferToolContract(tool);
  return {
    version: TOOL_PROTOCOL_VERSION,
    source: contract.source,
    category: contract.category,
    phase: contract.phase,
    risk: contract.risk,
    approval: contract.approval,
    recommendedNextTools: contract.recommendedAfterTools,
  };
}

export function describeToolForPrompt(tool: ToolDescriptor): string {
  const protocol = inferToolProtocol(tool);
  const contract = tool.contract ?? inferToolContract(tool);
  const effects = contract.effects
    ? ` effects: workspaceMutation=${contract.effects.workspaceMutation === true}, validationMode=${contract.effects.validationMode ?? "none"}`
    : "";
  const recommendations = protocol.recommendedNextTools.length > 0
    ? ` next=${protocol.recommendedNextTools.join(",")}`
    : "";
  const approval = tool.requiresApproval ? " requiresApproval=true" : "";
  return [
    `- ${tool.name}: ${tool.description}`,
    `(protocol=${protocol.version}; source=${protocol.source}; category=${protocol.category}; phase=${protocol.phase}; risk=${protocol.risk}; approval=${protocol.approval}; cost=${contract.cost}${recommendations})`,
    `(${describeToolContract(contract)})`,
    `(input schema: ${JSON.stringify(tool.inputSchema)})${effects}${approval}`,
  ].join(" ");
}

export function describeToolForNativeFunction(tool: ToolDescriptor): string {
  const protocol = inferToolProtocol(tool);
  const contract = tool.contract ?? inferToolContract(tool);
  const effects = contract.effects
    ? ` Effects: workspaceMutation=${contract.effects.workspaceMutation === true}, validationMode=${contract.effects.validationMode ?? "none"}.`
    : "";
  const approval = tool.requiresApproval ? " Runtime policy may pause this tool call for user approval." : "";
  const next = protocol.recommendedNextTools.length > 0
    ? ` Recommended next tools after useful output: ${protocol.recommendedNextTools.join(", ")}.`
    : "";
  const before = contract.recommendedBeforeTools.length > 0
    ? ` Recommended evidence before use: ${contract.recommendedBeforeTools.join(", ")}.`
    : "";
  const completion = contract.completionSignals.length > 0
    ? ` Completion signals: ${contract.completionSignals.join(", ")}.`
    : "";
  return [
    tool.description,
    `Tool protocol: ${protocol.version}; source=${protocol.source}; category=${protocol.category}; phase=${protocol.phase}; risk=${protocol.risk}; approval=${protocol.approval}.`,
    `Tool contract: ${contract.version}; cost=${contract.cost}.`,
    before,
    effects,
    next,
    completion,
    approval,
  ].join(" ").replace(/\s+/g, " ").trim().slice(0, 1024);
}

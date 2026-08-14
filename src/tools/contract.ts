import type {
  ToolApprovalMode,
  ToolContract,
  ToolContractCategory,
  ToolContractPhase,
  ToolContractSource,
  ToolCostClass,
  ToolDescriptor,
  ToolEffects,
  ToolRisk,
} from "./types.js";

export const TOOL_CONTRACT_VERSION = "shiguang.tool.contract.v1" as const;

export function withToolContract(tool: ToolDescriptor): ToolDescriptor {
  return {
    ...tool,
    contract: tool.contract ?? inferToolContract(tool),
  };
}

export function inferToolContract(tool: ToolDescriptor): ToolContract {
  const capability = tool.capability ?? tool.name;
  const category = inferCategory(capability, tool.name);
  const risk = tool.risk ?? inferRisk(capability, tool.effects?.workspaceMutation === true);
  const phase = inferPhase(capability, tool.name, tool.effects?.workspaceMutation === true, risk);
  const source: ToolContractSource = category === "mcp" || capability.startsWith("mcp.")
    ? "mcp-adapter"
    : "native";

  return {
    version: TOOL_CONTRACT_VERSION,
    source,
    category,
    phase,
    risk,
    approval: inferApprovalMode(tool.requiresApproval, risk),
    cost: inferCost(tool.name, capability, category, phase, risk),
    effects: normalizeEffects(tool.effects, risk),
    recommendedBeforeTools: inferRecommendedBeforeTools(tool.name, capability, phase, category),
    recommendedAfterTools: inferRecommendedAfterTools(tool.name, capability, phase),
    completionSignals: inferCompletionSignals(tool.name, capability, phase, risk),
    maxPromptChars: inferMaxPromptChars(tool.name, category, phase),
  };
}

export function describeToolContract(contract: ToolContract): string {
  const before = contract.recommendedBeforeTools.length > 0
    ? ` before=${contract.recommendedBeforeTools.join(",")}`
    : "";
  const after = contract.recommendedAfterTools.length > 0
    ? ` after=${contract.recommendedAfterTools.join(",")}`
    : "";
  const completion = contract.completionSignals.length > 0
    ? ` completion=${contract.completionSignals.join(",")}`
    : "";
  return [
    `contract=${contract.version}`,
    `source=${contract.source}`,
    `category=${contract.category}`,
    `phase=${contract.phase}`,
    `risk=${contract.risk}`,
    `approval=${contract.approval}`,
    `cost=${contract.cost}${before}${after}${completion}`,
  ].join("; ");
}

export function buildToolContractRegistry(tools: ToolDescriptor[]): Map<string, ToolContract> {
  return new Map(tools.map((tool) => [tool.name, tool.contract ?? inferToolContract(tool)]));
}

function inferCategory(capability: string, name: string): ToolContractCategory {
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

function inferPhase(
  capability: string,
  name: string,
  mutatesWorkspace: boolean,
  risk: ToolRisk,
): ToolContractPhase {
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

function inferApprovalMode(requiresApproval: boolean | undefined, risk: ToolRisk): ToolApprovalMode {
  if (requiresApproval === true) return "always";
  if (requiresApproval === false) return "never";
  return risk === "read" ? "never" : "on_risk";
}

function inferCost(
  name: string,
  capability: string,
  category: ToolContractCategory,
  phase: ToolContractPhase,
  risk: ToolRisk,
): ToolCostClass {
  if (
    name === "read_text_file"
    || name === "list_directory"
    || name === "stat_path"
    || name === "git_status"
    || name === "echo"
  ) {
    return "low";
  }
  if (
    name === "search_workspace"
    || name === "code_map"
    || name === "symbol_search"
    || name === "dependency_graph"
    || name === "collect_diagnostics"
    || name === "git_diff"
    || name === "run_validation"
  ) {
    return "medium";
  }
  if (category === "web" || category === "github" || category === "mcp") return "high";
  if (risk !== "read" || phase === "execute" || phase === "edit") return "high";
  if (/fetch|search|scan|dependency|diagnostic|validate/i.test(`${capability} ${name}`)) return "medium";
  return "low";
}

function inferRecommendedBeforeTools(
  name: string,
  capability: string,
  phase: ToolContractPhase,
  category: ToolContractCategory,
): string[] {
  if (name === "read_text_file" || capability === "fs.read") return ["stat_path", "list_directory"];
  if (name === "run_validation" || capability === "process.validate") return ["git_status"];
  if (phase === "edit") return ["read_text_file", "search_workspace"];
  if (phase === "execute") return category === "process" ? ["inspect_project", "read_text_file"] : ["read_text_file"];
  if (category === "github" || category === "web") return ["search_workspace"];
  return [];
}

function inferRecommendedAfterTools(name: string, capability: string, phase: ToolContractPhase): string[] {
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

function inferCompletionSignals(
  name: string,
  capability: string,
  phase: ToolContractPhase,
  risk: ToolRisk,
): string[] {
  if (name === "run_validation" || capability === "process.validate") return ["validation_result", "errors_or_success"];
  if (risk === "write" || phase === "edit") return ["workspace_mutation", "diff_or_written_path"];
  if (risk === "execute" || phase === "execute") return ["command_result", "exit_code"];
  if (phase === "inspect" || phase === "read") return ["evidence_observed"];
  return ["planner_signal"];
}

function inferMaxPromptChars(name: string, category: ToolContractCategory, phase: ToolContractPhase): number {
  if (name === "read_text_file") return 2400;
  if (name === "search_workspace") return 1800;
  if (category === "web" || category === "github" || category === "mcp") return 1200;
  if (phase === "inspect") return 1600;
  return 1000;
}

function normalizeEffects(effects: ToolEffects | undefined, risk: ToolRisk): ToolEffects {
  return {
    ...effects,
    workspaceMutation: effects?.workspaceMutation ?? risk === "write",
  };
}

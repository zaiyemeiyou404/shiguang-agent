import type { BrainDecision } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";

export interface Policy {
  check(decision: BrainDecision): Promise<BrainDecision>;
}

export interface ToolMetadataPolicyOptions {
  allowWithoutApproval?: string[];
}

export class ToolMetadataPolicy implements Policy {
  private readonly allowWithoutApproval: Set<string>;
  private readonly toolsByName: Map<string, ToolDescriptor>;

  constructor(tools: ToolDescriptor[], options: ToolMetadataPolicyOptions = {}) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.allowWithoutApproval = new Set(options.allowWithoutApproval ?? ["run_validation"]);
  }

  async check(decision: BrainDecision): Promise<BrainDecision> {
    if (decision.action.kind !== "tool_call" || !decision.action.toolName) {
      return decision;
    }

    const descriptor = this.toolsByName.get(decision.action.toolName);
    if (!descriptor) {
      return decision;
    }

    if (!descriptor.requiresApproval || this.allowWithoutApproval.has(descriptor.name)) {
      return decision;
    }

    // policy 不直接执行工具，只把高风险 tool_call 改写成 needs_approval 事件。
    const capability = descriptor.capability ?? descriptor.risk ?? "unknown";
    return {
      ...decision,
      action: {
        kind: "needs_approval",
        toolName: descriptor.name,
        toolInput: decision.action.toolInput,
        approvalId: `appr_${descriptor.name}`,
        capability,
        reason: `Tool requires approval before execution: ${descriptor.name} [${capability}]`,
      },
    };
  }
}

export class AllowAllPolicy implements Policy {
  async check(decision: BrainDecision): Promise<BrainDecision> {
    return decision;
  }
}

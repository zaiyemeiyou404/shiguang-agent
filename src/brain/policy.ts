import type { BrainDecision } from "./types.js";
import type { ToolDescriptor } from "../tools/types.js";
import { withToolContract } from "../tools/contract.js";

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
    this.toolsByName = new Map(tools.map((tool) => {
      const descriptor = withToolContract(tool);
      return [descriptor.name, descriptor];
    }));
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

    const needsApproval = descriptor.requiresApproval ?? (descriptor.contract?.approval !== "never");
    if (!needsApproval || this.allowWithoutApproval.has(descriptor.name)) {
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
        capability,
        reason: describeApprovalReason(descriptor, capability),
      },
    };
  }
}

function describeApprovalReason(descriptor: ToolDescriptor, capability: string): string {
  const risk = descriptor.risk ?? "execute";
  const effect = risk === "write"
    ? "这个动作可能修改、创建或删除工作区文件"
    : risk === "execute"
      ? "这个动作会运行命令或启动进程"
      : "这个动作需要访问受保护的信息";
  return `需要你确认后才能继续：${descriptor.name} [${capability}]。${effect}，本次批准只会执行当前这一次工具调用。`;
}

export class AllowAllPolicy implements Policy {
  async check(decision: BrainDecision): Promise<BrainDecision> {
    return decision;
  }
}

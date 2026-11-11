import type { PluginAdapter } from "./registry.js";
import type { Tool, ToolExecutionContext, ToolRisk } from "../tools/types.js";

export function createPluginTools(adapter: PluginAdapter): Tool[] {
  return adapter.manifest.capabilities.map((capability) => ({
    descriptor: {
      name: `${adapter.manifest.pluginId}_${capability.id}`.slice(0, 64),
      description: `[plugin:${adapter.manifest.pluginId}] ${capability.description}`,
      inputSchema: capability.inputSchema,
      risk: riskFor(capability.sideEffect),
      requiresApproval: capability.requiresApproval,
      capability: `${adapter.manifest.pluginId}.${capability.id}`,
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const result = await adapter.execute({
        pluginId: adapter.manifest.pluginId,
        capability: capability.id,
        input,
        signal: context?.signal,
      });
      if (context?.signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
      if (!result.ok && result.output == null) throw new Error(result.error ?? "plugin call failed");
      return result.output;
    },
  }));
}

function riskFor(sideEffect: string): ToolRisk {
  if (sideEffect === "write" || sideEffect === "external_mutation") return "write";
  if (sideEffect === "network") return "execute";
  return "read";
}

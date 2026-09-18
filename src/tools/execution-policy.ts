import { inferToolContract } from "./contract.js";
import type { ToolDescriptor, ToolExecutionContext } from "./types.js";

export type ToolPermissionResult = { allowed: true } | { allowed: false; reason: string };

/** Central policy check used before any tool side effect. */
export function checkToolPermission(tool: ToolDescriptor, context?: ToolExecutionContext): ToolPermissionResult {
  const grant = context?.executionGrant;
  // Existing callers remain compatible until a workspace explicitly enables grants.
  if (!grant) return { allowed: true };
  const contract = tool.contract ?? inferToolContract(tool);
  if (contract.risk === "read" && !grant.allowRead) return { allowed: false, reason: "Read access is not granted for this task." };
  if (contract.risk === "write" && !grant.allowWrite) return { allowed: false, reason: "Workspace write access requires approval." };
  if (contract.risk === "execute" && !grant.allowExecute) return { allowed: false, reason: "Terminal execution requires approval." };
  if ((contract.category === "web" || contract.category === "github" || contract.category === "mcp") && !grant.allowNetwork) {
    return { allowed: false, reason: "Network access is disabled for this task." };
  }
  return { allowed: true };
}

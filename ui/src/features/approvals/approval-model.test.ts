import { describe, expect, it } from "vitest";

import type { DesktopApproval, DesktopApprovalRequest } from "../../bridge";
import { normalizeApproval } from "./approval-model";

function approval(request: unknown, capability = "terminal.execute"): DesktopApproval {
  return {
    id: "approval-1",
    runId: "run-1",
    pluginId: "builtin",
    capability,
    status: "pending",
    request: request as DesktopApprovalRequest,
    decidedAt: null,
  };
}

describe("normalizeApproval", () => {
  it("normalizes command requests and retains the external-path warning", () => {
    const result = normalizeApproval(approval({
      toolName: "run_terminal_command",
      reason: "运行测试",
      toolInput: { command: "npm test", cwd: "G:\\repo" },
      preview: { title: "执行命令", path: "G:\\repo", warnings: ["命令可通过绝对路径影响工作区外文件"] },
    }));

    expect(result).toMatchObject({ title: "执行命令", summary: "运行测试", target: "G:\\repo", workingDirectory: "G:\\repo" });
    expect(result.warnings.join(" ")).toContain("绝对路径");
  });

  it("normalizes file mutation previews", () => {
    const result = normalizeApproval(approval({
      toolName: "write_file",
      preview: { title: "修改文件", path: "src/app.ts", operation: "write", additions: 3, deletions: 1, diff: "+new" },
    }, "filesystem.write"));

    expect(result).toMatchObject({ title: "修改文件", target: "src/app.ts", operation: "write", additions: 3, deletions: 1, diff: "+new" });
  });

  it("provides a useful generic fallback for malformed requests", () => {
    const result = normalizeApproval(approval("raw request", "plugin.custom"));
    expect(result.title).toBe("确认 plugin.custom 操作");
    expect(result.rawText).toContain("raw request");
  });
});

import { describe, expect, it } from "vitest";

import { normalizeDesktopApprovalRequest, normalizeDesktopEventPayload } from "./event-contracts.js";

describe("desktop event contracts", () => {
  it("canonicalizes tool input and preserves its call id", () => {
    expect(normalizeDesktopEventPayload("tool_call", {
      tool: "read_text_file",
      input: { path: "src/app.ts" },
      toolCallId: "call-1",
    })).toMatchObject({
      tool: "read_text_file",
      toolCallId: "call-1",
      arguments: { path: "src/app.ts" },
    });
  });

  it("turns malformed legacy errors into displayable messages", () => {
    expect(normalizeDesktopEventPayload("error", "legacy failure")).toMatchObject({ message: "legacy failure" });
  });

  it("normalizes approval request and preview fields", () => {
    expect(normalizeDesktopApprovalRequest({
      tool: "write_file",
      input: { path: "a.ts" },
      message: "需要写入",
      preview: { title: "修改文件", target: "a.ts", warnings: ["检查内容", 1] },
    })).toMatchObject({
      toolName: "write_file",
      toolInput: { path: "a.ts" },
      reason: "需要写入",
      preview: { title: "修改文件", path: "a.ts", warnings: ["检查内容"] },
    });
  });
});

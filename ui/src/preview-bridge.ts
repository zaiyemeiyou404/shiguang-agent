import type { DesktopConversationEntry, DesktopEvent, DesktopRun, DesktopSession, DesktopWorkspaceSnapshot, ShiguangBridge } from "./bridge";

const createdAt = "2026-09-25T14:30:00.000Z";
const session: DesktopSession = {
  id: "preview-session",
  workspaceId: "preview-workspace",
  title: "重构拾光 Agent 前端",
  status: "active",
  createdAt,
  updatedAt: createdAt,
  summary: "按 Codex 式工作台重构聊天、任务与上下文面板",
  llm: { provider: "deepseek", model: "deepseek-v4-flash", maxTokens: 8192 },
};
const run: DesktopRun = {
  id: "preview-run",
  sessionId: session.id,
  status: "running",
  reason: "正在核对新前端与设计稿的布局和事件流。",
  startedAt: createdAt,
  endedAt: null,
  summary: null,
  budget: { maxSteps: 12, stepsUsed: 5 },
  checkpoints: [
    { id: "step-1", taskId: "task-1", runId: "preview-run", kind: "completed", title: "替换旧页面入口", summary: "新工作台已成为唯一生产入口", createdAt },
    { id: "step-2", taskId: "task-1", runId: "preview-run", kind: "progress", title: "联调事件流", summary: "合并思考、工具与最终回复", createdAt },
    { id: "step-3", taskId: "task-1", runId: "preview-run", kind: "planned", title: "打包验证", summary: null, createdAt },
  ],
};
let conversation: DesktopConversationEntry[] = [
  { id: "turn-1", sessionId: session.id, runId: run.id, source: "turn", kind: "message", role: "user", from: "你", content: "继续写吧，之前的前端删干净，这个新前端适配并测试。", createdAt },
  { id: "turn-2", sessionId: session.id, runId: run.id, source: "turn", kind: "message", role: "assistant", from: "拾光 Agent", content: "旧页面已经退出生产入口。现在我在核对工作区绑定、运行事件、审批卡片和最终回复，确保它们在同一条对话流里只出现一次。", createdAt: "2026-09-25T14:31:00.000Z" },
];
let events: DesktopEvent[] = [
  { id: "event-1", runId: run.id, seq: 1, kind: "thinking", payload: { reasoning: "梳理现有桌面桥接与会话契约" }, createdAt },
  { id: "event-2", runId: run.id, seq: 2, kind: "thinking", payload: { reasoning: "将设计稿的聊天、任务抽屉和记忆状态映射到现有数据" }, createdAt: "2026-09-25T14:30:20.000Z" },
  { id: "event-3", runId: run.id, seq: 3, kind: "tool_call", payload: { tool: "read_many_files", toolCallId: "tool-1", input: { paths: ["ui/src/App.tsx", "ui/src/bridge.ts"] }, arguments: { paths: ["ui/src/App.tsx", "ui/src/bridge.ts"] } }, createdAt: "2026-09-25T14:30:30.000Z" },
  { id: "event-4", runId: run.id, seq: 4, kind: "tool_result", payload: { tool: "read_many_files", toolCallId: "tool-1", output: "已读取 2 个关键文件", isError: false }, createdAt: "2026-09-25T14:30:35.000Z" },
];

function snapshot(): DesktopWorkspaceSnapshot {
  return {
    detail: {
      session,
      runs: [run],
      turns: [],
      conversation,
      tokenUsage: { inputTokens: 2480, outputTokens: 1260, totalTokens: 3740, requests: 6, latestTotalTokens: 620 },
    },
    pendingApprovals: [],
    artifacts: [{ id: "artifact-1", sessionId: session.id, taskId: "task-1", runId: run.id, kind: "report", uri: "file:///G:/projects/shiguang/design-qa.md", title: "设计核对报告", metadata: {}, createdAt }],
  };
}

export function createPreviewBridge(): ShiguangBridge {
  return {
    listProjects: async () => [{ id: "preview-project", name: "拾光 Agent", createdAt, updatedAt: createdAt }],
    createProject: async ({ name }) => ({ id: `project-${Date.now()}`, name, createdAt, updatedAt: createdAt }),
    listWorkspaces: async () => [{ id: "preview-workspace", projectId: "preview-project", name: "默认工作区", rootPath: "G:/projects/agent-test/shiguang-agent", available: true, createdAt, updatedAt: createdAt }],
    createWorkspace: async (request) => ({ id: `workspace-${Date.now()}`, ...request, available: true, createdAt, updatedAt: createdAt }),
    listSessions: async () => [session],
    getSettings: async () => ({ configPath: "preview", workspaceRoot: "G:/projects/agent-test/shiguang-agent", toolApprovalMode: "ask", executionPreset: "workspace_write_network", llm: { provider: "deepseek", model: "deepseek-v4-flash", maxTokens: 8192 }, providers: { deepseek: { type: "openai-compatible", authMode: "api_key", baseURL: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", maxTokens: 8192 } }, mcpServers: {} }),
    saveSettings: async (value) => value,
    testProviderConnection: async (request) => ({ ok: true, providerKey: request.providerKey, providerType: request.provider.type ?? "openai-compatible", authSource: "direct", detail: "预览模式连接正常", checkedAt: createdAt }),
    createSession: async () => session,
    branchSession: async () => ({ session, sourceSession: session, sourceRun: run, suggestedPrompt: "从当前运行继续。" }),
    renameSession: async ({ title }) => ({ ...session, title }),
    updateSessionStatus: async ({ status }) => ({ ...session, status }),
    updateSessionWorkspace: async ({ workspaceRoot }) => ({ ...session, workspaceRoot }),
    updateSessionLlm: async ({ llm }) => ({ ...session, llm }),
    deleteSession: async ({ sessionId }) => ({ sessionId }),
    getSessionDetail: async () => snapshot().detail,
    getWorkspaceSnapshot: async () => snapshot(),
    listArtifacts: async () => snapshot().artifacts,
    openArtifact: async ({ uri }) => ({ uri, targetPath: uri }),
    revealArtifact: async ({ uri }) => ({ uri, targetPath: uri }),
    pickAttachments: async () => [],
    sendUserMessage: async ({ message }) => {
      const messageRun = { ...run, id: `run-${Date.now()}`, status: "pending" as const };
      conversation = [...conversation, { id: `turn-${Date.now()}`, sessionId: session.id, runId: messageRun.id, source: "turn", kind: "message", role: "user", from: "你", content: message, createdAt: new Date().toISOString() }];
      return messageRun;
    },
    getRunEvents: async () => events,
    listPendingApprovals: async () => [],
    listReusableApprovals: async () => [],
    revokeApprovalScope: async () => { throw new Error("预览模式没有授权记录"); },
    listWorkspaceMemories: async () => [],
    forgetWorkspaceMemory: async () => {},
    markWorkspaceMemoryStale: async () => {},
    listMemoryCandidates: async () => [],
    acceptMemoryCandidate: async () => { throw new Error("预览模式没有记忆候选"); },
    dismissMemoryCandidate: async () => {},
    decideApproval: async () => { throw new Error("预览模式没有待审批操作"); },
    cancelRun: async () => ({ ...run, status: "cancelled" }),
    pauseRun: async () => ({ ...run, status: "paused" }),
    retryRun: async () => ({ ...run, id: `run-${Date.now()}`, status: "pending" }),
    subscribeRunEvents: (_runId, callback) => {
      const timer = window.setTimeout(() => {
        const next: DesktopEvent = { id: "event-live", runId: run.id, seq: 5, kind: "thinking", payload: { reasoning: "正在进行浏览器级视觉核对" }, createdAt: new Date().toISOString() };
        events = [...events, next];
        callback(next);
      }, 600);
      return () => window.clearTimeout(timer);
    },
  };
}

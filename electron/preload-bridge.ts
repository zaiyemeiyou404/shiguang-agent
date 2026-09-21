import type { IpcRenderer } from "electron";
import type {
  ShiguangBridge,
  DesktopEvent,
  DesktopSettings,
  DesktopProviderConnectionRequest,
  DesktopProviderConnectionResult,
  CreateProjectRequest,
  CreateWorkspaceRequest,
  CreateSessionRequest,
} from "./types.js";

export const SHIGUANG_BRIDGE_METHODS = [
  "listProjects", "createProject", "listWorkspaces", "createWorkspace", "listSessions",
  "getSettings", "saveSettings", "testProviderConnection", "createSession", "branchSession",
  "renameSession", "updateSessionStatus", "updateSessionWorkspace", "updateSessionLlm", "deleteSession",
  "getSessionDetail", "getWorkspaceSnapshot", "listArtifacts", "openArtifact", "revealArtifact",
  "pickAttachments", "sendUserMessage", "getRunEvents", "listPendingApprovals", "listReusableApprovals", "revokeApprovalScope", "listWorkspaceMemories", "forgetWorkspaceMemory", "decideApproval",
  "cancelRun", "pauseRun", "retryRun", "subscribeRunEvents",
] as const satisfies readonly (keyof ShiguangBridge)[];

export function createShiguangBridge(ipcRenderer: IpcRenderer): ShiguangBridge {
  const bridge: ShiguangBridge = {
    listProjects: () => ipcRenderer.invoke("listProjects"),
    createProject: (req: CreateProjectRequest) => ipcRenderer.invoke("createProject", req),
    listWorkspaces: () => ipcRenderer.invoke("listWorkspaces"),
    createWorkspace: (req: CreateWorkspaceRequest) => ipcRenderer.invoke("createWorkspace", req),
    listSessions: () => ipcRenderer.invoke("listSessions"),
    getSettings: () => ipcRenderer.invoke("getSettings") as Promise<DesktopSettings>,
    saveSettings: (settings: DesktopSettings) => ipcRenderer.invoke("saveSettings", settings) as Promise<DesktopSettings>,
    testProviderConnection: (req: DesktopProviderConnectionRequest) => ipcRenderer.invoke("testProviderConnection", req) as Promise<DesktopProviderConnectionResult>,
    createSession: (req: CreateSessionRequest) => ipcRenderer.invoke("createSession", req),
    branchSession: (req) => ipcRenderer.invoke("branchSession", req),
    renameSession: (req) => ipcRenderer.invoke("renameSession", req),
    updateSessionStatus: (req) => ipcRenderer.invoke("updateSessionStatus", req),
    updateSessionWorkspace: (req) => ipcRenderer.invoke("updateSessionWorkspace", req),
    updateSessionLlm: (req) => ipcRenderer.invoke("updateSessionLlm", req),
    deleteSession: (req) => ipcRenderer.invoke("deleteSession", req),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke("getSessionDetail", sessionId),
    getWorkspaceSnapshot: (sessionId: string) => ipcRenderer.invoke("getWorkspaceSnapshot", sessionId),
    listArtifacts: (sessionId: string, runId?: string) => ipcRenderer.invoke("listArtifacts", sessionId, runId),
    openArtifact: (req) => ipcRenderer.invoke("openArtifact", req),
    revealArtifact: (req) => ipcRenderer.invoke("revealArtifact", req),
    pickAttachments: () => ipcRenderer.invoke("pickAttachments"),
    sendUserMessage: (req) => ipcRenderer.invoke("sendUserMessage", req),
    getRunEvents: (runId: string) => ipcRenderer.invoke("getRunEvents", runId),
    listPendingApprovals: (sessionId: string) => ipcRenderer.invoke("listPendingApprovals", sessionId),
    listReusableApprovals: (sessionId: string) => ipcRenderer.invoke("listReusableApprovals", sessionId),
    revokeApprovalScope: (approvalId: string) => ipcRenderer.invoke("revokeApprovalScope", approvalId),
    listWorkspaceMemories: (sessionId: string) => ipcRenderer.invoke("listWorkspaceMemories", sessionId),
    forgetWorkspaceMemory: (sessionId: string, memoryId: string) => ipcRenderer.invoke("forgetWorkspaceMemory", sessionId, memoryId),
    decideApproval: (req) => ipcRenderer.invoke("decideApproval", req),
    cancelRun: (req) => ipcRenderer.invoke("cancelRun", req),
    pauseRun: (req) => ipcRenderer.invoke("pauseRun", req),
    retryRun: (req) => ipcRenderer.invoke("retryRun", req),
    subscribeRunEvents: (runId: string, callback: (event: DesktopEvent) => void) => {
      const subscriptionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let disposed = false;
      const handler = (_event: Electron.IpcRendererEvent, data: DesktopEvent) => {
        if (data.runId === runId) callback(data);
      };
      ipcRenderer.on(`run-event:${subscriptionId}`, handler);
      void ipcRenderer.invoke("subscribeRunEvents", { runId, subscriptionId }).then(() => {
        if (disposed) void ipcRenderer.invoke("unsubscribeRunEvents", { subscriptionId });
      });
      return () => {
        disposed = true;
        ipcRenderer.removeListener(`run-event:${subscriptionId}`, handler);
        void ipcRenderer.invoke("unsubscribeRunEvents", { subscriptionId });
      };
    },
  };
  assertShiguangBridge(bridge);
  return bridge;
}

export function assertShiguangBridge(value: Partial<Record<keyof ShiguangBridge, unknown>>): asserts value is ShiguangBridge {
  const missing = SHIGUANG_BRIDGE_METHODS.filter((method) => typeof value[method] !== "function");
  if (missing.length > 0) throw new Error(`Shiguang preload bridge is missing required methods: ${missing.join(", ")}`);
}

import { contextBridge, ipcRenderer } from "electron";
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

// Sandboxed Electron preloads can only require a very small built-in allowlist.
// Keep this bridge self-contained so it works in both packaged and development
// windows without relaxing the renderer sandbox.
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
  decideApproval: (req) => ipcRenderer.invoke("decideApproval", req),
  cancelRun: (req) => ipcRenderer.invoke("cancelRun", req),
  pauseRun: (req) => ipcRenderer.invoke("pauseRun", req),
  retryRun: (req) => ipcRenderer.invoke("retryRun", req),
  subscribeRunEvents: (runId: string, callback: (event: DesktopEvent) => void) => {
    const subscriptionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let disposed = false;
    const channel = `run-event:${subscriptionId}`;
    const handler = (_event: Electron.IpcRendererEvent, data: DesktopEvent) => {
      if (data.runId === runId) callback(data);
    };
    ipcRenderer.on(channel, handler);
    void ipcRenderer.invoke("subscribeRunEvents", { runId, subscriptionId }).then(() => {
      if (disposed) void ipcRenderer.invoke("unsubscribeRunEvents", { subscriptionId });
    });
    return () => {
      disposed = true;
      ipcRenderer.removeListener(channel, handler);
      void ipcRenderer.invoke("unsubscribeRunEvents", { subscriptionId });
    };
  },
};

contextBridge.exposeInMainWorld("shiguang", bridge);

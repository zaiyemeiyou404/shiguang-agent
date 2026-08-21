import { contextBridge, ipcRenderer } from "electron";
import type {
  ShiguangBridge,
  DesktopEvent,
  DesktopSettings,
  DesktopProviderConnectionRequest,
  DesktopProviderConnectionResult,
} from "./types.js";

const bridge: ShiguangBridge = {
  listSessions: () => ipcRenderer.invoke("listSessions"),
  getSettings: () => ipcRenderer.invoke("getSettings") as Promise<DesktopSettings>,
  saveSettings: (settings: DesktopSettings) => ipcRenderer.invoke("saveSettings", settings) as Promise<DesktopSettings>,
  testProviderConnection: (req: DesktopProviderConnectionRequest) => ipcRenderer.invoke("testProviderConnection", req) as Promise<DesktopProviderConnectionResult>,
  createSession: (title?: string) => ipcRenderer.invoke("createSession", title),
  branchSession: (req) => ipcRenderer.invoke("branchSession", req),
  renameSession: (req) => ipcRenderer.invoke("renameSession", req),
  updateSessionStatus: (req) => ipcRenderer.invoke("updateSessionStatus", req),
  updateSessionWorkspace: (req) => ipcRenderer.invoke("updateSessionWorkspace", req),
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
    void ipcRenderer.invoke("subscribeRunEvents", runId);
    const handler = (_event: Electron.IpcRendererEvent, data: DesktopEvent) => {
      if (data.runId === runId) {
        callback(data);
      }
    };
    ipcRenderer.on("run-event", handler);
    return () => {
      ipcRenderer.removeListener("run-event", handler);
    };
  },
};

contextBridge.exposeInMainWorld("shiguang", bridge);

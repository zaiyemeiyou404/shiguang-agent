import { contextBridge, ipcRenderer } from "electron";
import type { ShiguangBridge, DesktopEvent } from "./types.js";

const bridge: ShiguangBridge = {
  listSessions: () => ipcRenderer.invoke("listSessions"),
  createSession: (title?: string) => ipcRenderer.invoke("createSession", title),
  getSessionDetail: (sessionId: string) => ipcRenderer.invoke("getSessionDetail", sessionId),
  sendUserMessage: (req) => ipcRenderer.invoke("sendUserMessage", req),
  getRunEvents: (runId: string) => ipcRenderer.invoke("getRunEvents", runId),
  subscribeRunEvents: (runId: string, callback: (event: DesktopEvent) => void) => {
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

import { ipcMain, BrowserWindow } from "electron";
import type { DesktopService } from "./service.js";
import type { SendMessageRequest, DesktopSettings, ApprovalDecisionRequest, RunActionRequest } from "./types.js";

export function registerIpcHandlers(service: DesktopService): void {
  ipcMain.handle("listSessions", () => {
    return service.listSessions();
  });

  ipcMain.handle("getSettings", () => {
    return service.getSettings();
  });

  ipcMain.handle("saveSettings", (_event, settings: DesktopSettings) => {
    return service.saveSettings(settings);
  });

  ipcMain.handle("createSession", (_event, title?: string) => {
    return service.createSession(title);
  });

  ipcMain.handle("getSessionDetail", (_event, sessionId: string) => {
    return service.getSessionDetail(sessionId);
  });

  ipcMain.handle("sendUserMessage", (_event, req: SendMessageRequest) => {
    return service.sendUserMessage(req.sessionId, req.message);
  });

  ipcMain.handle("getRunEvents", (_event, runId: string) => {
    return service.getRunEvents(runId);
  });

  ipcMain.handle("listPendingApprovals", (_event, sessionId: string) => {
    return service.listPendingApprovals(sessionId);
  });

  ipcMain.handle("decideApproval", (_event, req: ApprovalDecisionRequest) => {
    return service.decideApproval(req.approvalId, req.decision);
  });

  ipcMain.handle("cancelRun", (_event, req: RunActionRequest) => {
    return service.cancelRun(req.runId);
  });

  ipcMain.handle("retryRun", (_event, req: RunActionRequest) => {
    return service.retryRun(req.runId);
  });

  ipcMain.handle("subscribeRunEvents", (event, runId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const unsubscribe = service.subscribeRunEvents(runId, (desktopEvent) => {
      if (!win.isDestroyed()) {
        win.webContents.send("run-event", desktopEvent);
      }
    });

    event.sender.on("destroyed", () => unsubscribe());
  });
}

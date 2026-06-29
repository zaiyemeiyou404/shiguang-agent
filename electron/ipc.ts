import { ipcMain, BrowserWindow } from "electron";
import type { DesktopService } from "./service.js";
import type { SendMessageRequest } from "./types.js";

export function registerIpcHandlers(service: DesktopService): void {
  ipcMain.handle("listSessions", () => {
    return service.listSessions();
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

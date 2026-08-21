import { ipcMain } from "electron";
import type { DesktopAppService } from "./app-service.js";
import type { SendMessageRequest, DesktopSettings, ApprovalDecisionRequest, RunActionRequest, DesktopProviderConnectionRequest, SessionRenameRequest, SessionStatusRequest, SessionWorkspaceRequest, SessionDeleteRequest, SessionBranchRequest, ArtifactActionRequest } from "./types.js";

export function registerIpcHandlers(service: DesktopAppService): void {
  ipcMain.handle("listSessions", () => {
    return service.listSessions();
  });

  ipcMain.handle("getSettings", () => {
    return service.getSettings();
  });

  ipcMain.handle("saveSettings", (_event, settings: DesktopSettings) => {
    return service.saveSettings(settings);
  });

  ipcMain.handle("testProviderConnection", (_event, req: DesktopProviderConnectionRequest) => {
    return service.testProviderConnection(req);
  });

  ipcMain.handle("createSession", (_event, title?: string) => {
    return service.createSession(title);
  });

  ipcMain.handle("branchSession", (_event, req: SessionBranchRequest) => {
    return service.branchSessionFromRun(req.runId, req.title);
  });

  ipcMain.handle("renameSession", (_event, req: SessionRenameRequest) => {
    return service.renameSession(req.sessionId, req.title);
  });

  ipcMain.handle("updateSessionStatus", (_event, req: SessionStatusRequest) => {
    return service.updateSessionStatus(req.sessionId, req.status);
  });

  ipcMain.handle("updateSessionWorkspace", (_event, req: SessionWorkspaceRequest) => {
    return service.updateSessionWorkspace(req.sessionId, req.workspaceRoot);
  });

  ipcMain.handle("deleteSession", (_event, req: SessionDeleteRequest) => {
    return service.deleteSession(req.sessionId);
  });

  ipcMain.handle("getSessionDetail", (_event, sessionId: string) => {
    return service.getSessionDetail(sessionId);
  });

  ipcMain.handle("getWorkspaceSnapshot", (_event, sessionId: string) => {
    return service.getWorkspaceSnapshot(sessionId);
  });

  ipcMain.handle("listArtifacts", (_event, sessionId: string, runId?: string) => {
    return service.listArtifacts(sessionId, runId);
  });

  ipcMain.handle("openArtifact", (_event, req: ArtifactActionRequest) => {
    return service.openArtifact(req.uri);
  });

  ipcMain.handle("revealArtifact", (_event, req: ArtifactActionRequest) => {
    return service.revealArtifact(req.uri);
  });

  ipcMain.handle("pickAttachments", () => {
    return service.pickAttachments();
  });

  ipcMain.handle("sendUserMessage", (_event, req: SendMessageRequest) => {
    return service.sendUserMessage(req.sessionId, req.message, req.attachments ?? []);
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

  ipcMain.handle("pauseRun", (_event, req: RunActionRequest) => {
    return service.pauseRun(req.runId);
  });

  ipcMain.handle("retryRun", (_event, req: RunActionRequest) => {
    return service.retryRun(req.runId);
  });

  ipcMain.handle("subscribeRunEvents", (event, runId: string) => {
    const unsubscribe = service.subscribeRunEvents(runId, (desktopEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("run-event", desktopEvent);
      }
    });

    event.sender.on("destroyed", () => unsubscribe());
  });
}

import { ipcMain } from "electron";
import type { DesktopAppService } from "./app-service.js";
import type { SendMessageRequest, DesktopSettings, ApprovalDecisionRequest, RunActionRequest, DesktopProviderConnectionRequest, SessionRenameRequest, SessionStatusRequest, SessionWorkspaceRequest, SessionLlmRequest, SessionDeleteRequest, SessionBranchRequest, ArtifactActionRequest, CreateProjectRequest, CreateWorkspaceRequest, CreateSessionRequest } from "./types.js";
import type { RunEventSubscriptionRequest, RunEventUnsubscribeRequest } from "./types.js";
import { RunEventSubscriptionRegistry } from "./run-event-subscriptions.js";

export function registerIpcHandlers(service: DesktopAppService): void {
  const runEventSubscriptions = new RunEventSubscriptionRegistry(service);
  ipcMain.handle("listProjects", () => service.listProjects());
  ipcMain.handle("createProject", (_event, req: CreateProjectRequest) => service.createProject(req.name));
  ipcMain.handle("listWorkspaces", () => service.listWorkspaces());
  ipcMain.handle("createWorkspace", (_event, req: CreateWorkspaceRequest) => service.createWorkspace(req));

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

  ipcMain.handle("createSession", (_event, req: CreateSessionRequest) => {
    return service.createSession(req);
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

  ipcMain.handle("updateSessionLlm", (_event, req: SessionLlmRequest) => {
    return service.updateSessionLlm(req.sessionId, req.llm);
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

  ipcMain.handle("subscribeRunEvents", (event, req: RunEventSubscriptionRequest) => {
    runEventSubscriptions.subscribe(event.sender, req.runId, req.subscriptionId);
  });

  ipcMain.handle("unsubscribeRunEvents", (event, req: RunEventUnsubscribeRequest) => {
    runEventSubscriptions.unsubscribe(event.sender.id, req.subscriptionId);
  });
}

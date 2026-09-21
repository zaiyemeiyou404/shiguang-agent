import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

interface TaskRecord {
  id: string; sessionId: string; parentTaskId: string | null; title: string; description: string | null;
  status: string; priority: number; createdAt: Date; updatedAt: Date;
}
interface RunRecord {
  id: string; sessionId: string; taskId: string; status: string; reason: string | null;
  startedAt: Date | null; endedAt: Date | null; model: string | null; summary: string | null;
}
interface ApprovalRecord {
  id: string; runId: string; pluginId: string; capability: string; status: string;
  request: unknown; decidedAt: Date | null; scope?: string;
}
interface RunEventRecord { seq: number; kind: string; payload: unknown }

interface LifecycleInternals {
  taskRepository: { create(task: TaskRecord): Promise<void>; get(id: string): Promise<TaskRecord | null> };
  runRepository: { create(run: RunRecord): Promise<void>; get(id: string): Promise<RunRecord | null> };
  approvalRepository: {
    create(approval: ApprovalRecord): Promise<void>;
    get(id: string): Promise<ApprovalRecord | null>;
  };
  runEventRepository: { listByRun(runId: string): Promise<RunEventRecord[]> };
  memoryRepository: { create(memory: { id: string; workspaceScope: string | null; scope: string; kind: string; summary: string; content: string; salience: number; lastAccessedAt: Date | null; sourceType: "user"; sourceId: string; confidence: number; createdAt: Date; updatedAt: Date }): Promise<void> };
  resumeRunAfterApproval(approval: ApprovalRecord): Promise<void>;
}

const environmentKeys = ["SHIGUANG_USER_DATA_DIR", "SHIGUANG_WORKSPACE_ROOT"] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const temporaryDirectories: string[] = [];
const databaseHandles = new Set<{ close(): void }>();

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const database of databaseHandles) database.close();
  databaseHandles.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function createFixture() {
  const userDataRoot = mkdtempSync(join(tmpdir(), "shiguang-lifecycle-characterization-"));
  const workspaceRoot = join(userDataRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  temporaryDirectories.push(userDataRoot);
  process.env.SHIGUANG_USER_DATA_DIR = userDataRoot;
  process.env.SHIGUANG_WORKSPACE_ROOT = workspaceRoot;

  const [{ DesktopStore }, { DesktopAppService }] = await Promise.all([
    import("./store.js"),
    import("./app-service.js"),
  ]);
  const service = new DesktopAppService(new DesktopStore());
  for (const value of Object.values(service as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const database = (value as { db?: unknown }).db;
    if (database && typeof database === "object" && "close" in database) {
      databaseHandles.add(database as { close(): void });
    }
  }
  const session = await service.createSession("Lifecycle characterization");
  const internals = service as unknown as LifecycleInternals;
  const now = new Date("2026-09-18T00:00:00.000Z");
  const task: TaskRecord = {
    id: "task-lifecycle",
    sessionId: session.id,
    parentTaskId: null,
    title: "Lifecycle task",
    description: null,
    status: "waiting_approval",
    priority: 0,
    createdAt: now,
    updatedAt: now,
  };
  const run: RunRecord = {
    id: "run-lifecycle",
    sessionId: session.id,
    taskId: task.id,
    status: "needs_approval",
    reason: null,
    startedAt: now,
    endedAt: null,
    model: "characterization",
    summary: null,
  };
  await internals.taskRepository.create(task);
  await internals.runRepository.create(run);
  return { service, internals, session, task, run };
}

function approval(id: string, runId: string): ApprovalRecord {
  return {
    id,
    runId,
    pluginId: "builtin",
    capability: "fs.write",
    status: "pending",
    request: { toolName: "write_text_file", toolInput: { path: "result.txt", content: "ok" } },
    decidedAt: null,
    scope: "once",
  };
}

describe("DesktopAppService approval and cancellation characterization", () => {
  it("persists grant and denial once, resumes only grants, and keeps ordered events", async () => {
    const { service, internals, run } = await createFixture();
    const granted = approval("approval-granted", run.id);
    const denied = approval("approval-denied", run.id);
    await internals.approvalRepository.create(granted);
    await internals.approvalRepository.create(denied);
    const resume = vi.spyOn(internals, "resumeRunAfterApproval").mockResolvedValue();

    await expect(service.decideApproval(granted.id, "granted")).resolves.toMatchObject({
      id: granted.id,
      status: "granted",
    });
    await expect(service.decideApproval(granted.id, "granted")).resolves.toMatchObject({
      id: granted.id,
      status: "granted",
    });
    await expect(service.decideApproval(denied.id, "denied")).resolves.toMatchObject({
      id: denied.id,
      status: "denied",
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect((await internals.approvalRepository.get(granted.id))?.status).toBe("granted");
    expect((await internals.approvalRepository.get(denied.id))?.status).toBe("denied");
    const events = await internals.runEventRepository.listByRun(run.id);
    expect(events.map((event) => event.kind)).toEqual([
      "tool_pipeline",
      "approval_granted",
      "tool_pipeline",
      "approval_denied",
    ]);
    expect(events.filter((event) => event.kind.startsWith("approval_")).map((event) => event.kind))
      .toEqual(["approval_granted", "approval_denied"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("lists reusable workspace grants and revokes them back to one-time approval", async () => {
    const { service, internals, session, run } = await createFixture();
    const granted = approval("approval-workspace", run.id);
    await internals.approvalRepository.create(granted);
    vi.spyOn(internals, "resumeRunAfterApproval").mockResolvedValue();

    await service.decideApproval(granted.id, "granted", "workspace");
    await expect(service.listReusableApprovals(session.id)).resolves.toMatchObject([{
      id: granted.id,
      capability: granted.capability,
      scope: "workspace",
    }]);

    await expect(service.revokeApprovalScope(granted.id)).resolves.toMatchObject({
      id: granted.id,
      scope: "once",
    });
    await expect(service.listReusableApprovals(session.id)).resolves.toEqual([]);
  });

  it("lists and deletes only memories belonging to the active workspace", async () => {
    const { service, internals, session } = await createFixture();
    const now = new Date("2026-09-18T00:00:00.000Z");
    const memory = {
      id: "memory-workspace", workspaceScope: process.env.SHIGUANG_WORKSPACE_ROOT!, scope: "workspace", kind: "fact",
      summary: "Test workspace memory", content: "Keep this only in the active workspace.", salience: 0.8,
      lastAccessedAt: null, sourceType: "user" as const, sourceId: "test", confidence: 0.9, createdAt: now, updatedAt: now,
    };
    await internals.memoryRepository.create(memory);

    await expect(service.listWorkspaceMemories(session.id)).resolves.toMatchObject([{ id: memory.id, summary: memory.summary }]);
    await expect(service.forgetWorkspaceMemory(session.id, memory.id)).resolves.toBeUndefined();
    await expect(service.listWorkspaceMemories(session.id)).resolves.toEqual([]);
  });

  it("cancels a run, expires pending approvals, and appends an ordered system event", async () => {
    const { service, internals, task, run } = await createFixture();
    const pending = approval("approval-pending", run.id);
    await internals.approvalRepository.create(pending);

    await expect(service.cancelRun(run.id)).resolves.toMatchObject({
      id: run.id,
      status: "cancelled",
      reason: "Cancelled by user.",
    });

    expect((await internals.runRepository.get(run.id))?.status).toBe("cancelled");
    expect((await internals.taskRepository.get(task.id))?.status).toBe("cancelled");
    expect((await internals.approvalRepository.get(pending.id))?.status).toBe("expired");
    const events = await internals.runEventRepository.listByRun(run.id);
    expect(events.map((event) => event.seq)).toEqual([1]);
    expect(events[0]).toMatchObject({ kind: "system", payload: { message: "run cancelled by user" } });
  });
});

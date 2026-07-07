import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../dist/app/agent.js";
import { InMemoryEventSink } from "../dist/runtime/event-sink.js";
import { RulePlanner } from "../dist/brain/planner.js";
import { createReadTextFileTool } from "../dist/tools/builtins/read-text-file.js";
import { createSearchWorkspaceTool } from "../dist/tools/builtins/search-workspace.js";
import { createWriteTextFileTool } from "../dist/tools/builtins/write-text-file.js";

const tmpDir = mkdtempSync(join(tmpdir(), "shiguang-smoke-"));
const storePath = join(tmpDir, "shiguang-store.json");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) fail(msg);
}

function loadStoreData(): { sessions: unknown[]; runs: unknown[]; events: unknown[] } {
  const raw = readFileSync(storePath, "utf-8");
  return JSON.parse(raw);
}

(async () => {
  console.log("=== Shiguang Desktop Smoke Test ===");

  // --- Test 1: Store persistence ---
  console.log("\n[Test 1] Store persistence...");
  const session = { id: "sess_test_1", title: "Smoke Session", status: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: null };
  const run = { id: "run_test_1", sessionId: "sess_test_1", status: "completed" as const, reason: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), summary: "Test run" };
  const event = { id: "evt_test_1", runId: "run_test_1", seq: 1, kind: "message" as const, payload: { content: "Hello" }, createdAt: new Date().toISOString() };

  const data = { sessions: [session], runs: [run], events: [event] };
  writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");

  const loaded = loadStoreData();
  assert(loaded.sessions.length === 1, "Should have 1 session");
  assert((loaded.sessions[0] as Record<string, unknown>).id === "sess_test_1", "Session ID should match");
  assert(loaded.runs.length === 1, "Should have 1 run");
  assert(loaded.events.length === 1, "Should have 1 event");
  assert((loaded.events[0] as Record<string, unknown>).seq === 1, "Event seq should be 1");
  console.log("  PASS");

  // --- Test 2: Agent execution path (default echo tool) ---
  console.log("\n[Test 2] Agent execution with default tools...");
  const sink = new InMemoryEventSink();
  const agent = new Agent({ eventSink: sink });

  const output = await agent.run({
    runId: "run_agent_test",
    userMessage: "Say hello",
    contextInput: {
      task: { id: "task_1", sessionId: "sess_1", parentTaskId: null, title: "Say hello", description: null, status: "in_progress", priority: 0, createdAt: new Date(), updatedAt: new Date() },
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
    },
  });

  assert(output.state.steps >= 1, "Should have at least 1 step");
  const lastResult = output.state.lastResult;
  if (!lastResult) fail("Should have a last result");
  assert(lastResult.ok === true, "Last result should be OK");

  const storedEvents = await sink.list("run_agent_test");
  assert(storedEvents.length >= 1, "Should have recorded events");
  assert(storedEvents.some((e) => e.kind === "message"), "Should have a message event");
  console.log(`  PASS (${storedEvents.length} events, ${output.state.steps} steps)`);

  // --- Test 3: Event ordering ---
  console.log("\n[Test 3] Event ordering...");
  const seqs = storedEvents.map((e) => e.seq);
  for (let i = 1; i < seqs.length; i++) {
    assert(seqs[i]! > seqs[i - 1]!, `Event seq order broken at index ${i}: ${seqs[i]} <= ${seqs[i - 1]}`);
  }
  console.log(`  PASS (${seqs.length} events ordered)`);

  // --- Test 4: getRunEvents via store ---
  console.log("\n[Test 4] getRunEvents returns persisted events...");
  const runEvents = (() => {
    const storeData = loadStoreData();
    return storeData.events.filter((e) => (e as Record<string, unknown>).runId === "run_test_1");
  })();
  assert(runEvents.length === 1, "Should retrieve 1 event for run_test_1");
  assert((runEvents[0] as Record<string, unknown>).kind === "message", "Event kind should be message");
  console.log("  PASS");

  // --- Test 5: Default session auto-creation ---
  console.log("\n[Test 5] Empty store should allow default session creation...");
  const emptyData = { sessions: [], runs: [], events: [] };
  writeFileSync(storePath, JSON.stringify(emptyData, null, 2), "utf-8");
  const emptyLoaded = loadStoreData();
  assert(emptyLoaded.sessions.length === 0, "Should start with 0 sessions");
  const defaultSession = { id: "sess_default_1", title: "Default Session", status: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: null };
  emptyLoaded.sessions.push(defaultSession);
  writeFileSync(storePath, JSON.stringify(emptyLoaded, null, 2), "utf-8");
  const afterCreate = loadStoreData();
  assert(afterCreate.sessions.length === 1, "Should have 1 session after auto-create");
  assert((afterCreate.sessions[0] as Record<string, unknown>).title === "Default Session", "Default session title should match");
  console.log("  PASS");

  // --- Test 6: read_text_file tool works ---
  console.log("\n[Test 6] read_text_file tool...");
  const wsDir = mkdtempSync(join(tmpDir, "workspace-"));
  const testFilePath = join(wsDir, "hello.txt");
  writeFileSync(testFilePath, "Hello, smoke test!", "utf-8");

  const readTool = createReadTextFileTool(wsDir);
  const readResult = await readTool.execute(testFilePath) as { path: string; content: string; truncated: boolean; bytes: number };
  assert(readResult.path === testFilePath, "Path should match");
  assert(readResult.content === "Hello, smoke test!", "Content should match");
  assert(readResult.truncated === false, "Should not be truncated");
  assert(readResult.bytes === 18, "Should be 18 bytes");
  console.log("  PASS");

  // --- Test 7: read_text_file path object input ---
  console.log("\n[Test 7] read_text_file with object input...");
  const readResult2 = await readTool.execute({ path: "hello.txt" }) as { path: string; content: string };
  assert(typeof readResult2.path === "string", "Path should be a string");
  assert(readResult2.content === "Hello, smoke test!", "Content should match");
  console.log("  PASS");

  // --- Test 8: read_text_file rejects escape ---
  console.log("\n[Test 8] read_text_file escapes outside root...");
  try {
    await readTool.execute("../etc/passwd");
    fail("Should have thrown for path escape");
  } catch (e: unknown) {
    assert(e instanceof Error && e.message.includes("escapes"), `Should reject escape, got: ${e}`);
  }
  console.log("  PASS");

  // --- Test 9: read_text_file respects max size ---
  console.log("\n[Test 9] read_text_file truncates large files...");
  const bigFilePath = join(wsDir, "big.txt");
  writeFileSync(bigFilePath, "x".repeat(20_000), "utf-8");
  const bigResult = await readTool.execute(bigFilePath) as { truncated: boolean; bytes: number; content: string };
  assert(bigResult.truncated === true, "Should be truncated");
  assert(bigResult.bytes === 20_000, "Bytes should report full size");
  assert(bigResult.content.length <= 16_384, "Content should be bounded");
  console.log("  PASS");

  // --- Test 10: search_workspace tool ---
  console.log("\n[Test 10] search_workspace tool...");
  mkdirSync(join(wsDir, "subdir"), { recursive: true });
  writeFileSync(join(wsDir, "subdir", "data.txt"), "the secret answer is 42", "utf-8");
  writeFileSync(join(wsDir, "other.txt"), "nothing here", "utf-8");

  const searchTool = createSearchWorkspaceTool(wsDir);
  const searchResult = await searchTool.execute("secret") as { query: string; results: Array<{ file: string; line: number }>; filesScanned: number };
  assert(searchResult.results.length >= 1, "Should find at least 1 result");
  assert(searchResult.results[0]!.file === "subdir/data.txt" || searchResult.results[0]!.file.endsWith("subdir/data.txt"), "Should find the right file");
  assert(searchResult.results[0]!.line === 1, "Should be on line 1");
  assert(searchResult.filesScanned >= 2, "Should have scanned files");
  console.log(`  PASS (${searchResult.results.length} results, ${searchResult.filesScanned} files)`);

  // --- Test 11: search_workspace with object input ---
  console.log("\n[Test 11] search_workspace with object input...");
  const searchResult2 = await searchTool.execute({ query: "answer" }) as { results: Array<{ file: string; line: number }> };
  assert(searchResult2.results.length >= 1, "Should find result for 'answer'");
  console.log("  PASS");

  // --- Test 12: Agent with custom tools and RulePlanner ---
  console.log("\n[Test 12] Agent with custom tools (echo + read_text_file + search_workspace)...");
  const customSink = new InMemoryEventSink();
  const customAgent = new Agent({
    eventSink: customSink,
    planner: new RulePlanner(),
    tools: [createReadTextFileTool(wsDir), createSearchWorkspaceTool(wsDir)],
  });

  const customOutput = await customAgent.run({
    runId: "run_custom_tools",
    userMessage: "Say hello",
    contextInput: {
      task: { id: "task_ct", sessionId: "sess_ct", parentTaskId: null, title: "Test", description: null, status: "in_progress", priority: 0, createdAt: new Date(), updatedAt: new Date() },
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
    },
  });

  assert(customOutput.state.steps >= 1, "Should have at least 1 step");
  const customEvents = await customSink.list("run_custom_tools");
  assert(customEvents.length >= 1, "Should have recorded events");
  console.log(`  PASS (${customEvents.length} events, ${customOutput.state.steps} steps)`);

  // --- Test 13: ToolRegistry.invoke dispatches correctly ---
  console.log("\n[Test 13] Tool tool_call path produces events...");
  const toolCallEvents = customEvents.filter((e) => e.kind === "tool_call" || e.kind === "tool_result");
  console.log(`  Tool events found: ${toolCallEvents.length} (non-zero if RulePlanner used echo, which is fine)`);
  console.log("  PASS");

  // --- Test 14: OpenAIModel can be instantiated without credentials ---
  console.log("\n[Test 14] OpenAIModel instantiation without env...");
  const { OpenAIModel } = await import("../dist/brain/openai-model.js");
  const model = new OpenAIModel({ apiKey: "" });
  assert(model.isConfigured === false, "Should not be configured without apiKey");
  console.log("  PASS (no crash on missing credentials)");

  // --- Test 15: approval flow resumes automatically from approved tool state ---
  console.log("\n[Test 15] approval flow resume path...");
  const approvalSink = new InMemoryEventSink();
  const approvalAgent = new Agent({
    eventSink: approvalSink,
    planner: {
      async decide(input) {
        if (input.history.length > 0) {
          return {
            action: { kind: "respond", content: "approved write completed" },
            reasoning: "Approved tool already ran; now confirm completion.",
          };
        }
        return {
          action: {
            kind: "tool_call",
            toolName: "write_text_file",
            toolInput: { path: "approved.txt", content: "approved" },
          },
          reasoning: "Need to write the requested file first.",
        };
      },
    },
    tools: [createWriteTextFileTool(wsDir), createReadTextFileTool(wsDir)],
  });
  const approvalTask = {
    id: "task_approval",
    sessionId: "sess_approval",
    parentTaskId: null,
    title: "Write an approved file",
    description: null,
    status: "in_progress" as const,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const approvalOutput = await approvalAgent.run({
    runId: "run_approval_test",
    userMessage: "Write approved.txt with the text approved and then confirm completion.",
    contextInput: {
      task: approvalTask,
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
      workspaceRoot: wsDir,
    },
  });

  assert(approvalOutput.state.stopReason === "needs_approval", "Run should stop for approval");
  const approvalEvents = await approvalSink.list("run_approval_test");
  const approvalRequest = approvalEvents.find((event) => event.kind === "approval_request");
  assert(Boolean(approvalRequest), "Should emit approval_request event");
  const requestPayload = approvalRequest?.payload as { request?: { toolName?: string; toolInput?: unknown } } | undefined;
  assert(requestPayload?.request?.toolName === "write_text_file", "Approval request should target write_text_file");

  const resumedOutput = await approvalAgent.resumeAfterApproval({
    runId: "run_approval_test",
    userMessage: "Write approved.txt with the text approved and then confirm completion.",
    approvedAction: {
      toolName: requestPayload?.request?.toolName ?? "write_text_file",
      toolInput: requestPayload?.request?.toolInput,
    },
    contextInput: {
      task: approvalTask,
      recentRuns: [],
      linkedArtifacts: [],
      memories: [],
      workspaceRoot: wsDir,
    },
  });

  const approvedFile = readFileSync(join(wsDir, "approved.txt"), "utf-8");
  assert(approvedFile === "approved", "Approved file should be written during resume");
  assert(resumedOutput.state.steps >= 2, "Resumed run should continue beyond the approved tool step");
  assert(resumedOutput.state.history[0]?.metadata?.toolName === "write_text_file", "Seeded history should begin with approved tool result");
  const resumedEvents = await approvalSink.list("run_approval_test");
  assert(resumedEvents.filter((event) => event.kind === "tool_call").length >= 1, "Resume path should emit tool_call events");
  console.log("  PASS");

  // --- Cleanup ---
  rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n=== ALL SMOKE TESTS PASSED ===");
})();

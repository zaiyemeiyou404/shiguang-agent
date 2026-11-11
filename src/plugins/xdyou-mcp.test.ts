import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpStdioClient } from "../tools/mcp-stdio-runtime.js";
import { xdyouMcpCommand } from "./xdyou-mcp.js";

test("xdyou MCP adapter lists campus tools and reads a local cache", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdyou-mcp-"));
  const launch = xdyouMcpCommand();
  const client = new McpStdioClient({
    id: "xdyou",
    command: launch.command,
    args: launch.args,
    env: { XDYOU_DATA_DIR: dir, XDYOU_BOARD: "0" },
  }, {
    discoveryTimeoutMs: 8_000,
    requestTimeoutMs: 8_000,
    clientInfo: { name: "xdyou-mcp-test", version: "1.0.0" },
  });

  try {
    writeFileSync(join(dir, "ClassTable.json"), JSON.stringify({
      semesterLength: 16,
      semesterCode: "2025-2026-1",
      termStartDay: "2025-09-01",
      classDetail: [{ name: "编译原理" }],
      timeArrangement: [{
        index: 0,
        week_list: Array(16).fill(true),
        day: 1,
        start: 1,
        stop: 2,
        source: "school",
        classroom: "B-202",
      }],
    }));

    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["aircon", "airconlive", "attendance", "card", "classrooms", "electricity", "exams", "experiments", "forum", "library", "loans", "login", "meters", "network", "schedule", "schoolnet", "scores", "sport", "sportclass", "status", "water"]);
    const interactive = new Set(["login", "card", "loans", "schoolnet", "forum", "sport", "sportclass", "attendance", "meters", "water"]);
    assert.equal(tools.filter((tool) => typeof tool.name !== "string" || !interactive.has(tool.name)).every((tool) => {
      const annotations = tool.annotations as { readOnlyHint?: boolean } | undefined;
      return annotations?.readOnlyHint === true;
    }), true);
    const login = tools.find((tool) => tool.name === "login");
    const loginAnnotations = login?.annotations as { readOnlyHint?: boolean; openWorldHint?: boolean } | undefined;
    assert.equal(loginAnnotations?.readOnlyHint, false);
    assert.equal(loginAnnotations?.openWorldHint, true);
    const card = tools.find((tool) => tool.name === "card");
    const cardAnnotations = card?.annotations as { readOnlyHint?: boolean; openWorldHint?: boolean } | undefined;
    assert.equal(cardAnnotations?.readOnlyHint, false);
    assert.equal(cardAnnotations?.openWorldHint, true);

    const result = await client.callTool("schedule", { date: "2025-09-01" }) as {
      isError?: boolean;
      structuredContent?: { classes?: Array<{ name?: string; classroom?: string }> };
    };
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent?.classes?.[0]?.name, "编译原理");
    assert.equal(result.structuredContent?.classes?.[0]?.classroom, "B-202");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

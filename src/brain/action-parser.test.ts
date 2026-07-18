import { test } from "node:test";
import * as assert from "node:assert/strict";

import { tryParseAction } from "./action-parser.js";

test("tryParseAction parses plain JSON", () => {
  const result = tryParseAction(JSON.stringify({ kind: "finish", content: "done" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.kind, "finish");
  }
});

test("tryParseAction parses fenced JSON blocks", () => {
  const result = tryParseAction("```json\n{\n  \"kind\": \"respond\",\n  \"content\": \"hi\"\n}\n```");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.kind, "respond");
  }
});

test("tryParseAction extracts the first JSON object from prose", () => {
  const result = tryParseAction("I will do it now. {\"kind\":\"tool_call\",\"toolName\":\"search_workspace\",\"toolInput\":{\"query\":\"planner\"}} Thanks.");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.kind, "tool_call");
    if (result.action.kind === "tool_call") {
      assert.equal(result.action.toolName, "search_workspace");
    }
  }
});

test("tryParseAction repairs trailing commas and bare keys", () => {
  const result = tryParseAction('{kind:"finish", content:"done",}');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.kind, "finish");
  }
});

test("tryParseAction repairs single-quoted JSON-like output", () => {
  const result = tryParseAction("{'kind':'respond','content':'fixed'}");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.kind, "respond");
  }
});

test("tryParseAction preserves clear parse errors when no valid object exists", () => {
  const result = tryParseAction("not json at all");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Failed to parse JSON/);
  }
});

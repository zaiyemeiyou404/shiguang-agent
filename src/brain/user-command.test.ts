import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseUserCommand, stripToolRoutingDirectives } from "./user-command.js";

test("parseUserCommand separates search objective from explicit skill routing", () => {
  const parsed = parseUserCommand("查一下网络搜索的概念，并调用web_article_reader");

  assert.equal(parsed.raw, "查一下网络搜索的概念，并调用web_article_reader");
  assert.equal(parsed.objective, "查一下网络搜索的概念");
  assert.equal(parsed.normalizedSearchQuery, "网络搜索的概念");
  assert.equal(parsed.modeHint, "web");
  assert.deepEqual(parsed.toolDirectives, ["web_article_reader"]);
  assert.deepEqual(parsed.skillDirectives, ["web_article_reader"]);
  assert.equal(parsed.hasExplicitToolRouting, true);
});

test("parseUserCommand preserves the concept term when it starts with 网络搜索", () => {
  const parsed = parseUserCommand("网络搜索的概念是什么？");

  assert.equal(parsed.objective, "网络搜索的概念是什么？");
  assert.equal(parsed.normalizedSearchQuery, "网络搜索的概念是什么");
});

test("stripToolRoutingDirectives removes English tool instructions without removing the task", () => {
  assert.equal(
    stripToolRoutingDirectives("search network search concepts and use web_article_reader"),
    "search network search concepts",
  );
});

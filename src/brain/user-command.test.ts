import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseUserCommand, stripToolRoutingDirectives } from "./user-command.js";

test("parseUserCommand separates search objective from explicit skill routing", () => {
  const parsed = parseUserCommand("查一下网络搜索的概念，并调用web_article_reader");

  assert.equal(parsed.raw, "查一下网络搜索的概念，并调用web_article_reader");
  assert.equal(parsed.objective, "查一下网络搜索的概念");
  assert.equal(parsed.normalizedSearchQuery, "网络搜索的概念");
  assert.equal(parsed.modeHint, "web");
  assert.equal(parsed.taskKind, "web_search");
  assert.deepEqual(parsed.toolDirectives, ["web_article_reader"]);
  assert.deepEqual(parsed.skillDirectives, ["web_article_reader"]);
  assert.equal(parsed.hasExplicitToolRouting, true);
  assert.deepEqual(parsed.commandContract, {
    version: "shiguang.command.v1",
    original: "查一下网络搜索的概念，并调用web_article_reader",
    objective: "查一下网络搜索的概念",
    route: "web",
    taskKind: "web_search",
    targets: {
      urls: [],
      paths: [],
    },
    directives: {
      tools: ["web_article_reader"],
      skills: ["web_article_reader"],
      output: [],
      constraints: [],
    },
    immutable: true,
  });
});

test("parseUserCommand preserves the concept term when it starts with 网络搜索", () => {
  const parsed = parseUserCommand("网络搜索的概念是什么？");

  assert.equal(parsed.objective, "网络搜索的概念是什么？");
  assert.equal(parsed.normalizedSearchQuery, "网络搜索的概念是什么");
});

test("parseUserCommand routes local file translation to workspace instead of web", () => {
  const parsed = parseUserCommand("翻译一下工作区文件");

  assert.equal(parsed.objective, "翻译一下工作区文件");
  assert.equal(parsed.modeHint, "workspace");
  assert.equal(parsed.taskKind, "file_transform");
});

test("parseUserCommand keeps command targets separate from tool directives", () => {
  const parsed = parseUserCommand("读取 G:\\projects\\demo\\README.md 并使用read_text_file");

  assert.equal(parsed.objective, "读取 G:\\projects\\demo\\README.md");
  assert.equal(parsed.commandContract.targets.paths[0], "G:\\projects\\demo\\README.md");
  assert.deepEqual(parsed.commandContract.directives.tools, ["read_text_file"]);
});

test("parseUserCommand distinguishes article reading, debugging, and release work", () => {
  assert.equal(parseUserCommand("看一下 https://example.test/article 的正文").taskKind, "web_article");
  assert.equal(parseUserCommand("这个项目报错了，帮我排查").taskKind, "debug");
  assert.equal(parseUserCommand("打包并更新 GitHub release").taskKind, "release");
});

test("stripToolRoutingDirectives removes English tool instructions without removing the task", () => {
  assert.equal(
    stripToolRoutingDirectives("search network search concepts and use web_article_reader"),
    "search network search concepts",
  );
});

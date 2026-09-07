import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";

type CustomExtensionsModule = typeof import("./custom-extensions.js");

async function loadModule(): Promise<CustomExtensionsModule> {
  return import("./custom-extensions.js");
}

async function makeExtensionRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "custom-extensions-"));
}

test("custom extension tools create, list, and run a declarative custom tool", async () => {
  const {
    createCustomExtensionTools,
    loadCustomExtensionTools,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const tools = createCustomExtensionTools(extensionRoot);
  const createTool = tools.find((tool) => tool.descriptor.name === "create_custom_tool");
  const listTool = tools.find((tool) => tool.descriptor.name === "list_custom_extensions");
  const runTool = tools.find((tool) => tool.descriptor.name === "run_custom_tool");

  assert.ok(createTool);
  assert.ok(listTool);
  assert.ok(runTool);
  assert.equal(createTool.descriptor.requiresApproval, true);

  const created = await createTool.execute({
    name: "Greeting Helper",
    description: "Formats a greeting",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    template: "你好，{{ name }}。",
  }) as { name: string; status: string };

  assert.equal(created.name, "custom_greeting_helper");
  assert.equal(created.status, "created");

  const directRun = await runTool.execute({
    name: "greeting_helper",
    input: { name: "拾光" },
  }) as { output: string };
  assert.equal(directRun.output, "你好，拾光。");

  const loadedTools = loadCustomExtensionTools(extensionRoot);
  const loaded = loadedTools.find((tool) => tool.descriptor.name === "custom_greeting_helper");
  assert.ok(loaded);
  assert.equal(loaded.descriptor.requiresApproval, false);
  const loadedRun = await loaded.execute({ name: "Agent" }) as { output: string };
  assert.equal(loadedRun.output, "你好，Agent。");

  const listed = await listTool.execute({}) as {
    tools: Array<{ name: string; enabled: boolean; templateChars: number }>;
  };
  assert.equal(listed.tools.length, 1);
  assert.equal(listed.tools[0]?.name, "custom_greeting_helper");
  assert.equal(listed.tools[0]?.enabled, true);
  assert.ok((listed.tools[0]?.templateChars ?? 0) > 0);
});

test("custom skills support layered trigger-based selection", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    formatCustomSkillInstructions,
    selectCustomSkills,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const createSkill = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "create_custom_skill");
  assert.ok(createSkill);

  await createSkill.execute({
    name: "web article reader",
    description: "Read web article bodies",
    layer: "domain",
    scope: "web_fetch",
    triggers: ["http", "网页", "文章", "新闻", "正文"],
    priority: 85,
    instructions: "Explicit URLs must be fetched directly and summarized from the real article body.",
  });
  await createSkill.execute({
    name: "python reviewer",
    description: "Review Python files",
    layer: "domain",
    scope: "read_text_file",
    triggers: ["python", ".py"],
    priority: 70,
    instructions: "Focus on Python code quality.",
  });

  const skills = loadCustomSkills(extensionRoot);
  const selectedForWeb = selectCustomSkills(skills, {
    userMessage: "看一下这个 https://example.test/news.html 的正文",
    availableTools: ["web_fetch", "web_search"],
  });
  assert.deepEqual(selectedForWeb.map((skill) => skill.name), ["web_article_reader"]);

  const prompt = formatCustomSkillInstructions(skills, {
    userMessage: "看一下这个 https://example.test/news.html 的正文",
    availableTools: ["web_fetch", "web_search"],
  });
  assert.ok(prompt);
  assert.match(prompt, /Layer: domain/);
  assert.match(prompt, /Scope: web_fetch/);
  assert.match(prompt, /Explicit URLs must be fetched directly/);
  assert.doesNotMatch(prompt, /Focus on Python code quality/);
});

test("custom skill selection honors explicit skill names in the user request", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    selectCustomSkills,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const createSkill = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "create_custom_skill");
  assert.ok(createSkill);

  await createSkill.execute({
    name: "web article reader",
    description: "Read web article bodies",
    layer: "domain",
    scope: "web_fetch",
    triggers: ["http", "article"],
    priority: 85,
    instructions: "When explicitly requested, use the article reader workflow.",
  });

  const skills = loadCustomSkills(extensionRoot);
  const selected = selectCustomSkills(skills, {
    userMessage: "查一下网络搜索的概念，并调用web_article_reader",
    availableTools: ["web_search", "web_fetch"],
  });

  assert.deepEqual(selected.map((skill) => skill.name), ["web_article_reader"]);
});

test("custom skill selection does not leak project skills into standalone web requests", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    selectCustomSkills,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const createSkill = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "create_custom_skill");
  assert.ok(createSkill);

  await createSkill.execute({
    name: "xdyou maintainer",
    description: "Maintain XDYou Flutter project",
    layer: "project",
    triggers: ["traintime_pda-main", "watermeter", "xdyou"],
    priority: 90,
    instructions: "Use XDYou project maintenance workflow.",
  });

  const skills = loadCustomSkills(extensionRoot);
  const selectedForProject = selectCustomSkills(skills, {
    userMessage: "继续分析这个项目",
    workspaceRoot: "G:/projects/worktest/traintime_pda-main",
    availableTools: ["read_text_file", "code_map"],
  });
  assert.deepEqual(selectedForProject.map((skill) => skill.name), ["xdyou_maintainer"]);

  const selectedForWeb = selectCustomSkills(skills, {
    userMessage: "看一下这个 https://www.sohu.com/a/899892876_121968518",
    workspaceRoot: "G:/projects/worktest/traintime_pda-main",
    availableTools: ["web_fetch", "web_search"],
  });
  assert.deepEqual(selectedForWeb.map((skill) => skill.name), []);
});

test("project custom skills without triggers are still excluded from standalone web requests", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    selectCustomSkills,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const createSkill = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "create_custom_skill");
  assert.ok(createSkill);

  await createSkill.execute({
    name: "workspace habit",
    description: "Project-only habits",
    layer: "project",
    priority: 50,
    instructions: "Only apply inside local project analysis tasks.",
  });

  const skills = loadCustomSkills(extensionRoot);
  const selected = selectCustomSkills(skills, {
    userMessage: "read this page https://example.test/news",
    workspaceRoot: "G:/projects/current-app",
    availableTools: ["web_fetch", "web_search"],
  });

  assert.deepEqual(selected.map((skill) => skill.name), []);
});

test("default web article reader skill is seeded and selected for URLs", async () => {
  const {
    ensureDefaultCustomSkills,
    loadCustomSkills,
    formatCustomSkillInstructions,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();

  const created = ensureDefaultCustomSkills(extensionRoot);
  assert.equal(created.length, 1);

  const skills = loadCustomSkills(extensionRoot);
  const webSkill = skills.find((skill) => skill.name === "web_article_reader");
  assert.ok(webSkill);
  assert.equal(webSkill.layer, "domain");
  assert.equal(webSkill.scope, "web_fetch");

  const prompt = formatCustomSkillInstructions(skills, {
    userMessage: "Please read https://example.test/story.html and summarize the article.",
    availableTools: ["web_fetch", "web_search"],
  });
  assert.ok(prompt);
  assert.match(prompt, /web_article_reader/);
  assert.match(prompt, /call web_fetch on that exact URL first/);
});

test("agent rules can be recorded as a durable custom skill", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    formatCustomSkillInstructions,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const recordRule = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "record_agent_rule");
  assert.ok(recordRule);
  assert.equal(recordRule.descriptor.requiresApproval, true);

  const recorded = await recordRule.execute({
    scope: "web_fetch",
    rule: "When a fetched news page includes articleCandidates, choose the candidate matching the article title before answering.",
    evidence: "A news page returned navigation text before the article body.",
  }) as { name: string; status: string; path: string };

  assert.equal(recorded.name, "agent_rules");
  assert.equal(recorded.status, "recorded");

  const skills = loadCustomSkills(extensionRoot);
  const rules = skills.find((skill) => skill.name === "agent_rules");
  assert.ok(rules);
  assert.match(rules.instructions, /When a fetched news page includes articleCandidates/);
  assert.match(rules.instructions, /web_fetch/);

  const prompt = formatCustomSkillInstructions(skills);
  assert.ok(prompt);
  assert.match(prompt, /Agent Rules/);
  assert.match(prompt, /articleCandidates/);
});

test("custom skills are rendered as prompt instructions when enabled", async () => {
  const {
    createCustomExtensionTools,
    loadCustomSkills,
    formatCustomSkillInstructions,
  } = await loadModule();
  const extensionRoot = await makeExtensionRoot();
  const createSkill = createCustomExtensionTools(extensionRoot).find((tool) => tool.descriptor.name === "create_custom_skill");
  assert.ok(createSkill);

  await createSkill.execute({
    name: "Review Voice",
    description: "Review style",
    instructions: "回答代码审查时先列风险，再给建议。",
  });

  const skills = loadCustomSkills(extensionRoot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "review_voice");

  const prompt = formatCustomSkillInstructions(skills);
  assert.ok(prompt);
  assert.match(prompt, /Relevant Shiguang skills are active/);
  assert.match(prompt, /回答代码审查时先列风险/);
});

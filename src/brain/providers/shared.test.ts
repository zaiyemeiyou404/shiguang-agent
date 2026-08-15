import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildProviderMessages } from "./shared.js";

test("provider messages include grounding policy from the shared system prompt", () => {
  const messages = buildProviderMessages({
    messages: [
      {
        role: "user",
        content: "分析这个文件",
      },
    ],
    availableTools: [],
    history: [],
  });

  const systemMessage = messages.find((message) => message.role === "system")?.content ?? "";

  assert.match(systemMessage, /Conversation grounding policy/);
  assert.match(systemMessage, /The latest user message is authoritative/);
  assert.match(systemMessage, /Do not claim the user explicitly requested a file\/path/);
  assert.equal(messages.at(-1)?.content, "分析这个文件");
});

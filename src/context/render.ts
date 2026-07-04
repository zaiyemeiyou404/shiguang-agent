import type { ContextBundle, RenderedPrompt, ContextItem } from "./types.js";
import type { Turn } from "../core/types.js";
import { isAbsolute } from "node:path";
import { artifactRef, isFileUri, isWindowsAbsolutePath, toFileUri } from "./windows-path.js";

export type { RenderedPrompt };

function layerHeader(layer: string, items: ContextItem[], format = formatContextItem): string {
  if (items.length === 0) return "";
  const lines = items.map(format);
  return `=== ${layer.toUpperCase()} CONTEXT ===\n${lines.join("\n")}`;
}

const DIGEST_LABELS: Partial<Record<ContextItem["kind"], string>> = {
  run_digest: "RUN DIGEST",
  memory_digest: "MEMORY DIGEST",
  artifact_digest: "ARTIFACT DIGEST",
  context_digest: "CONTEXT DIGEST",
};

function formatContextItem(item: ContextItem): string {
  const digestLabel = DIGEST_LABELS[item.kind];
  if (digestLabel) {
    return `[${digestLabel}]\n${item.content}`;
  }
  return `[${item.kind}] ${item.content}`;
}

function formatLiveRef(item: ContextItem): string {
  return `[ref:${item.kind}] ${artifactRef(item.source)}${item.content ? ` - ${item.content}` : ""}`;
}

function refUri(source: string): string | undefined {
  if (isFileUri(source)) return source;
  if (isWindowsAbsolutePath(source) || isAbsolute(source)) return toFileUri(source);
  return undefined;
}

export function renderPrompt(bundle: ContextBundle, priorTurns: Turn[] = []): RenderedPrompt {
  const systemItems = bundle.stable.filter(i => i.kind === "system_instruction");
  const stableContext = bundle.stable.filter(i => i.kind !== "system_instruction" && i.kind !== "user_turn");
  const volatileContext = bundle.volatile.filter(i => i.kind !== "user_turn");
  const currentUserTurn = [...bundle.volatile].reverse().find(i => i.kind === "user_turn");
  const stableText = layerHeader("stable", stableContext);
  const volatileText = layerHeader("volatile", volatileContext);
  const liveText = layerHeader("live", bundle.live, formatLiveRef);

  const systemContextParts: string[] = [];

  if (stableText) systemContextParts.push(stableText);
  if (volatileText) systemContextParts.push(volatileText);
  if (liveText) systemContextParts.push(liveText);

  const systemParts = systemItems.map(i => i.content);
  const systemContext = systemContextParts.join("\n\n");
  if (systemContext) {
    systemParts.push(`System context (not user intent):\n${systemContext}`);
  }
  const system = systemParts.join("\n\n");

  const refs = [...bundle.stable, ...bundle.volatile, ...bundle.live]
    .filter(i => i.kind === "file_ref" || i.kind === "artifact" || i.kind === "plugin_ref")
    .map(i => ({ kind: i.kind, source: artifactRef(i.source), uri: refUri(i.source) }));

  const messages: RenderedPrompt["messages"] = [];
  for (const turn of priorTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }
  if (currentUserTurn?.content) messages.push({ role: "user", content: currentUserTurn.content });

  return { system, messages, refs };
}

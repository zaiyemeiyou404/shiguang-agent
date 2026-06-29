import type { PluginCallRequest, PluginCallResult } from "./types.js";
import type { PluginAdapter } from "./registry.js";

const EXAMPLE_FS_MANIFEST = {
  pluginId: "example-fs",
  name: "Example Filesystem Reader",
  version: "0.1.0",
  description: "Read-only plugin that lists files in the workspace directory.",
  capabilities: [
    {
      id: "list_files",
      description: "List top-level files and directories in a given path.",
      sideEffect: "read" as const,
      requiresApproval: false,
      timeoutMs: 5_000,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      outputSchema: {
        type: "object",
        properties: { entries: { type: "array" } },
      },
    },
    {
      id: "file_metadata",
      description: "Get file size and modification time for a single path.",
      sideEffect: "read" as const,
      requiresApproval: false,
      timeoutMs: 5_000,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      outputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          size: { type: "number" },
          isDirectory: { type: "boolean" },
          modifiedAt: { type: "string" },
        },
      },
    },
  ],
};

export const exampleFsAdapter: PluginAdapter = {
  manifest: EXAMPLE_FS_MANIFEST,

  async execute(request: PluginCallRequest): Promise<PluginCallResult> {
    const start = Date.now();
    try {
      switch (request.capability) {
        case "list_files": {
          const input = request.input as { path?: string };
          const fs = await import("node:fs");
          const entries = fs.readdirSync(input.path ?? ".", { withFileTypes: true });
          return {
            ok: true,
            output: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
            error: null,
            durationMs: Date.now() - start,
          };
        }
        case "file_metadata": {
          const input = request.input as { path?: string };
          const fs = await import("node:fs");
          const stat = fs.statSync(input.path ?? ".");
          return {
            ok: true,
            output: {
              name: input.path,
              size: stat.size,
              isDirectory: stat.isDirectory(),
              modifiedAt: stat.mtime.toISOString(),
            },
            error: null,
            durationMs: Date.now() - start,
          };
        }
        default:
          return { ok: false, output: null, error: `unknown capability: ${request.capability}`, durationMs: Date.now() - start };
      }
    } catch (err) {
      return { ok: false, output: null, error: String(err), durationMs: Date.now() - start };
    }
  },
};

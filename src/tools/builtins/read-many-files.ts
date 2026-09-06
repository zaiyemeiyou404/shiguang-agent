import { accessSync, constants, readFileSync, statSync } from "node:fs";
import type { Tool, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toPortablePath } from "./path-format.js";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES_PER_FILE = 8_192;
const HARD_MAX_FILES = 20;
const HARD_MAX_BYTES_PER_FILE = 20_000;

interface ReadManyFilesInput {
  paths: string[];
  maxBytesPerFile?: number;
}

interface ReadManyFileEntry {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  ok: boolean;
  error?: string;
}

interface ReadManyFilesOutput {
  files: ReadManyFileEntry[];
  totalFiles: number;
  failed: number;
  hint: string;
}

function parseInput(input: unknown): ReadManyFilesInput {
  if (Array.isArray(input)) {
    return { paths: input.filter((item): item is string => typeof item === "string") };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("read_many_files: input must be { paths } or an array of paths");
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.paths)) {
    throw new Error("read_many_files: paths must be an array of strings");
  }
  return {
    paths: record.paths.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ...(typeof record.maxBytesPerFile === "number" ? { maxBytesPerFile: record.maxBytesPerFile } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_BYTES_PER_FILE;
  return Math.max(1_000, Math.min(HARD_MAX_BYTES_PER_FILE, Math.trunc(value ?? DEFAULT_MAX_BYTES_PER_FILE)));
}

function readOne(workspaceRoot: string, rawPath: string, maxBytes: number): ReadManyFileEntry {
  try {
    const fullPath = resolveWorkspacePath(workspaceRoot, rawPath);
    accessSync(fullPath, constants.R_OK);
    const stats = statSync(fullPath);
    if (!stats.isFile()) {
      return { path: toPortablePath(fullPath), content: "", truncated: false, bytes: 0, ok: false, error: "Path is not a file." };
    }
    const buf = readFileSync(fullPath);
    return {
      path: toPortablePath(fullPath),
      content: buf.toString("utf-8").slice(0, maxBytes),
      truncated: buf.length > maxBytes,
      bytes: buf.length,
      ok: true,
    };
  } catch (error) {
    return {
      path: rawPath,
      content: "",
      truncated: false,
      bytes: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createReadManyFilesTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "read_many_files",
      description: "Read several text files in one workspace-safe call. Use after inspect_project/code_map when multiple key files are needed.",
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Relative or absolute paths inside the workspace root.",
          },
          maxBytesPerFile: {
            type: "number",
            description: "Optional per-file byte budget. Default 8192, hard max 20000.",
          },
        },
        required: ["paths"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "fs.read_many",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<ReadManyFilesOutput> {
      throwIfAborted(context?.signal);
      const parsed = parseInput(input);
      const uniquePaths = Array.from(new Set(parsed.paths.map((path) => path.trim()).filter(Boolean))).slice(0, HARD_MAX_FILES);
      if (uniquePaths.length === 0) {
        throw new Error("read_many_files: provide at least one path");
      }
      const maxBytes = clampLimit(parsed.maxBytesPerFile);
      const selected = uniquePaths.slice(0, DEFAULT_MAX_FILES);
      const files = selected.map((path) => {
        throwIfAborted(context?.signal);
        return readOne(workspaceRoot, path, maxBytes);
      });
      const omitted = uniquePaths.length - selected.length;
      const failed = files.filter((file) => !file.ok).length;
      return {
        files,
        totalFiles: files.length,
        failed,
        hint: omitted > 0
          ? `Read ${files.length} file(s), omitted ${omitted} extra path(s). Re-run with a smaller focused list if needed.`
          : `Read ${files.length} file(s).`,
      };
    },
  };
}

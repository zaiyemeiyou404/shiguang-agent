import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, normalize, relative, join, extname } from "node:path";
import type { Tool } from "../types.js";

const MAX_RESULTS = 15;
const MAX_SNIPPET_BYTES = 512;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "release", ".tmp", "desktop-build", "ui/dist", ".codegraph"]);

const SKIP_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
]);

function isTextFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return !SKIP_EXTENSIONS.has(ext);
}

export interface SearchWorkspaceInput {
  query: string;
}

export interface SearchWorkspaceResult {
  file: string;
  line: number;
  snippet: string;
}

export interface SearchWorkspaceOutput {
  query: string;
  results: SearchWorkspaceResult[];
  truncated: boolean;
  filesScanned: number;
}

function resolveInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.query === "string") return obj.query;
  }
  throw new Error("search_workspace: input must be a string query or { query: string }");
}

function walkDir(dirPath: string, results: SearchWorkspaceResult[], query: string, workspaceRoot: string, depth: number): number {
  if (depth > 8) return 0;
  let scanned = 0;

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return scanned;

    const full = join(dirPath, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }

    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        scanned += walkDir(full, results, query, workspaceRoot, depth + 1);
      }
    } else if (s.isFile() && isTextFile(entry) && s.size > 0 && s.size < 1_048_576) {
      scanned++;
      try {
        const content = readFileSync(full, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(query.toLowerCase())) {
            const rel = relative(workspaceRoot, full);
            const snippet = lines[i]!.slice(0, MAX_SNIPPET_BYTES);
            results.push({ file: rel, line: i + 1, snippet });
            if (results.length >= MAX_RESULTS) return scanned;
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return scanned;
}

export function createSearchWorkspaceTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "search_workspace",
      description: "Recursively search workspace text files for a substring. Returns file paths with line snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
        },
        required: ["query"],
      },
    },
    async execute(input: unknown): Promise<SearchWorkspaceOutput> {
      const query = resolveInput(input);
      const root = resolve(normalize(workspaceRoot));

      const results: SearchWorkspaceResult[] = [];
      const filesScanned = walkDir(root, results, query, root, 0);

      return {
        query,
        results,
        truncated: results.length >= MAX_RESULTS,
        filesScanned,
      };
    },
  };
}

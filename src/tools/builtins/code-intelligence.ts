import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Tool, ToolExecutionContext } from "../types.js";
import { toPortablePath } from "./path-format.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  "desktop-build",
  ".tmp",
  "coverage",
  ".vite",
  ".codegraph",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
]);

const TEST_FILE_RE = /(?:^|[./\\])(?:__tests__|test|tests|spec)(?:[./\\])|(?:\.test|\.spec)\.[^.]+$/i;
const DEFAULT_SCAN_LIMIT = 1_200;
const MAX_FILE_BYTES = 512_000;

type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method"
  | "struct"
  | "enum"
  | "trait";

interface CodeFile {
  path: string;
  fullPath: string;
  extension: string;
  bytes: number;
  isTest: boolean;
}

interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
  signature: string;
}

interface DependencyEdge {
  from: string;
  to: string;
  specifier: string;
  kind: "local" | "package" | "builtin" | "unknown";
}

interface PackageInfo {
  name: string | null;
  version: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

function normalizeLimit(value: unknown, fallback = DEFAULT_SCAN_LIMIT, max = DEFAULT_SCAN_LIMIT): number {
  return Math.max(1, Math.min(max, Math.trunc(typeof value === "number" ? value : fallback)));
}

function readPackage(workspaceRoot: string): PackageInfo | null {
  const packagePath = join(workspaceRoot, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const dependencies = parsed.dependencies && typeof parsed.dependencies === "object" && !Array.isArray(parsed.dependencies)
      ? Object.keys(parsed.dependencies)
      : [];
    const devDependencies = parsed.devDependencies && typeof parsed.devDependencies === "object" && !Array.isArray(parsed.devDependencies)
      ? Object.keys(parsed.devDependencies)
      : [];
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      version: typeof parsed.version === "string" ? parsed.version : null,
      scripts,
      dependencies,
      devDependencies,
    };
  } catch {
    return null;
  }
}

function scanCodeFiles(
  workspaceRoot: string,
  opts: { maxFiles?: number; includeTests?: boolean } = {},
  context?: ToolExecutionContext,
): { files: CodeFile[]; truncated: boolean; directoriesVisited: number } {
  const maxFiles = normalizeLimit(opts.maxFiles, DEFAULT_SCAN_LIMIT, 5_000);
  const includeTests = opts.includeTests ?? true;
  const files: CodeFile[] = [];
  let truncated = false;
  let directoriesVisited = 0;

  function walk(dirPath: string, depth: number): void {
    throwIfAborted(context?.signal);
    if (depth > 10 || files.length >= maxFiles) {
      truncated = files.length >= maxFiles;
      return;
    }

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    directoriesVisited += 1;

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dirPath, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(extension)) continue;
      const fullPath = join(dirPath, entry.name);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) continue;
      const path = toPortablePath(relative(workspaceRoot, fullPath));
      const isTest = TEST_FILE_RE.test(path);
      if (!includeTests && isTest) continue;
      files.push({
        path,
        fullPath,
        extension,
        bytes: stats.size,
        isTest,
      });
    }
  }

  walk(workspaceRoot, 0);
  return { files, truncated, directoriesVisited };
}

function readTextFile(file: CodeFile): string {
  try {
    return readFileSync(file.fullPath, "utf8");
  } catch {
    return "";
  }
}

function extractSymbols(file: CodeFile, content: string): CodeSymbol[] {
  if (file.extension === ".py") return extractPythonSymbols(file, content);
  if (file.extension === ".go") return extractGoSymbols(file, content);
  if (file.extension === ".rs") return extractRustSymbols(file, content);
  return extractEcmaSymbols(file, content);
}

function extractEcmaSymbols(file: CodeFile, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const patterns: Array<{ re: RegExp; kind: SymbolKind; nameIndex: number; exported?: boolean }> = [
    { re: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, kind: "function", nameIndex: 1, exported: true },
    { re: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, kind: "function", nameIndex: 1 },
    { re: /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", nameIndex: 1, exported: true },
    { re: /^\s*class\s+([A-Za-z_$][\w$]*)/gm, kind: "class", nameIndex: 1 },
    { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/gm, kind: "interface", nameIndex: 1, exported: true },
    { re: /^\s*interface\s+([A-Za-z_$][\w$]*)/gm, kind: "interface", nameIndex: 1 },
    { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/gm, kind: "type", nameIndex: 1, exported: true },
    { re: /^\s*type\s+([A-Za-z_$][\w$]*)/gm, kind: "type", nameIndex: 1 },
    { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, kind: "variable", nameIndex: 1, exported: true },
    { re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: "variable", nameIndex: 1 },
  ];
  for (const pattern of patterns) {
    collectPatternSymbols(symbols, file, content, pattern.re, pattern.kind, pattern.nameIndex, pattern.exported ?? false);
  }
  return dedupeSymbols(symbols);
}

function extractPythonSymbols(file: CodeFile, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  collectPatternSymbols(symbols, file, content, /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm, "function", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*async\s+def\s+([A-Za-z_]\w*)\s*\(/gm, "function", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*class\s+([A-Za-z_]\w*)/gm, "class", 1, false);
  return dedupeSymbols(symbols);
}

function extractGoSymbols(file: CodeFile, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  collectPatternSymbols(symbols, file, content, /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm, "function", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm, "struct", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/gm, "interface", 1, false);
  return dedupeSymbols(symbols);
}

function extractRustSymbols(file: CodeFile, content: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  collectPatternSymbols(symbols, file, content, /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/gm, "function", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm, "struct", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm, "enum", 1, false);
  collectPatternSymbols(symbols, file, content, /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm, "trait", 1, false);
  return dedupeSymbols(symbols);
}

function collectPatternSymbols(
  symbols: CodeSymbol[],
  file: CodeFile,
  content: string,
  re: RegExp,
  kind: SymbolKind,
  nameIndex: number,
  exported: boolean,
): void {
  for (const match of content.matchAll(re)) {
    const name = match[nameIndex];
    if (!name || match.index === undefined) continue;
    const line = lineNumberAt(content, match.index);
    const signature = content.slice(match.index, content.indexOf("\n", match.index) === -1 ? undefined : content.indexOf("\n", match.index)).trim();
    symbols.push({ name, kind, file: file.path, line, exported, signature: signature.slice(0, 240) });
  }
}

function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.file}:${symbol.line}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractDependencies(file: CodeFile, content: string): DependencyEdge[] {
  if (file.extension === ".py") return extractPythonDependencies(file, content);
  if (file.extension === ".go") return extractGoDependencies(file, content);
  if (file.extension === ".rs") return extractRustDependencies(file, content);
  return extractEcmaDependencies(file, content);
}

function extractEcmaDependencies(file: CodeFile, content: string): DependencyEdge[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return Array.from(specs).map((specifier) => dependencyEdge(file, specifier));
}

function extractPythonDependencies(file: CodeFile, content: string): DependencyEdge[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.,\s]+))/gm)) {
    const fromSpec = match[1];
    if (fromSpec) specs.add(fromSpec);
    const importList = match[2];
    if (importList) {
      for (const item of importList.split(",")) {
        const name = item.trim().split(/\s+/)[0];
        if (name) specs.add(name);
      }
    }
  }
  return Array.from(specs).map((specifier) => dependencyEdge(file, specifier));
}

function extractGoDependencies(file: CodeFile, content: string): DependencyEdge[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    if (match[1]) specs.add(match[1]);
  }
  for (const block of content.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const match of (block[1] ?? "").matchAll(/"([^"]+)"/g)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return Array.from(specs).map((specifier) => dependencyEdge(file, specifier));
}

function extractRustDependencies(file: CodeFile, content: string): DependencyEdge[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(/^\s*use\s+([^;]+);/gm)) {
    if (match[1]) specs.add(match[1].trim());
  }
  for (const match of content.matchAll(/^\s*mod\s+([A-Za-z_]\w*)\s*;/gm)) {
    if (match[1]) specs.add(match[1]);
  }
  return Array.from(specs).map((specifier) => dependencyEdge(file, specifier));
}

function dependencyEdge(file: CodeFile, specifier: string): DependencyEdge {
  const kind = classifyDependency(specifier);
  return {
    from: file.path,
    to: kind === "local" ? normalizeLocalDependency(file.path, specifier) : packageName(specifier),
    specifier,
    kind,
  };
}

function classifyDependency(specifier: string): DependencyEdge["kind"] {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "local";
  if (/^(node:|fs$|path$|url$|crypto$|os$|util$|child_process$|stream$|http$|https$)/.test(specifier)) return "builtin";
  if (/^[A-Za-z0-9@][\w@./-]*$/.test(specifier)) return "package";
  return "unknown";
}

function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function normalizeLocalDependency(fromFile: string, specifier: string): string {
  const base = dirname(fromFile);
  const parts = `${base}/${specifier}`.split(/[\\/]+/);
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function detectEntrypoints(files: CodeFile[], pkg: PackageInfo | null): string[] {
  const candidates = new Set<string>();
  const names = new Set(files.map((file) => file.path));
  for (const candidate of [
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/main.tsx",
    "src/app.ts",
    "src/app.tsx",
    "electron/main.ts",
    "ui/src/main.tsx",
    "main.ts",
    "index.ts",
    "index.js",
    "app.py",
    "main.py",
    "cmd/main.go",
    "src/main.rs",
  ]) {
    if (names.has(candidate)) candidates.add(candidate);
  }
  if (pkg?.scripts) {
    for (const script of Object.values(pkg.scripts)) {
      for (const match of script.matchAll(/\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs))\b/g)) {
        if (match[1] && names.has(match[1])) candidates.add(match[1]);
      }
    }
  }
  return Array.from(candidates).slice(0, 20);
}

function detectFrameworks(pkg: PackageInfo | null, files: CodeFile[]): string[] {
  const deps = new Set([...(pkg?.dependencies ?? []), ...(pkg?.devDependencies ?? [])]);
  const names = new Set(files.map((file) => file.path));
  const frameworks: string[] = [];
  if (deps.has("electron") || names.has("electron/main.ts")) frameworks.push("electron");
  if (deps.has("react") || files.some((file) => file.extension === ".tsx")) frameworks.push("react");
  if (deps.has("vite") || names.has("ui/vite.config.ts")) frameworks.push("vite");
  if (deps.has("typescript") || names.has("tsconfig.json")) frameworks.push("typescript");
  if (names.has(".github/workflows/desktop-release.yml")) frameworks.push("github-actions");
  if (files.some((file) => file.extension === ".py")) frameworks.push("python");
  if (files.some((file) => file.extension === ".go")) frameworks.push("go");
  if (files.some((file) => file.extension === ".rs")) frameworks.push("rust");
  return frameworks;
}

function groupByDirectory(files: CodeFile[]): Array<{ directory: string; files: number; tests: number }> {
  const counts = new Map<string, { files: number; tests: number }>();
  for (const file of files) {
    const dir = dirname(file.path) === "." ? "." : dirname(file.path).split("/").slice(0, 2).join("/");
    const current = counts.get(dir) ?? { files: 0, tests: 0 };
    current.files += 1;
    if (file.isTest) current.tests += 1;
    counts.set(dir, current);
  }
  return Array.from(counts.entries())
    .map(([directory, count]) => ({ directory, ...count }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 30);
}

function extensionStats(files: CodeFile[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const file of files) {
    stats[file.extension] = (stats[file.extension] ?? 0) + 1;
  }
  return stats;
}

export function createCodeMapTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "code_map",
      description: "Build a compact map of the codebase: languages, likely entrypoints, key directories, symbols, and dependency hotspots.",
      inputSchema: {
        type: "object",
        properties: {
          maxFiles: { type: "number" },
          includeTests: { type: "boolean" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "code.map",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const pkg = readPackage(workspaceRoot);
      const scan = scanCodeFiles(workspaceRoot, {
        maxFiles: normalizeLimit(obj.maxFiles, DEFAULT_SCAN_LIMIT, 5_000),
        includeTests: typeof obj.includeTests === "boolean" ? obj.includeTests : true,
      }, context);
      const symbols: CodeSymbol[] = [];
      const edges: DependencyEdge[] = [];
      for (const file of scan.files) {
        const content = readTextFile(file);
        symbols.push(...extractSymbols(file, content));
        edges.push(...extractDependencies(file, content));
      }
      const dependencyCounts = new Map<string, number>();
      for (const edge of edges) {
        dependencyCounts.set(edge.to, (dependencyCounts.get(edge.to) ?? 0) + 1);
      }
      const hotspots = Array.from(dependencyCounts.entries())
        .map(([target, imports]) => ({ target, imports }))
        .sort((a, b) => b.imports - a.imports)
        .slice(0, 25);

      return {
        workspaceRoot,
        package: pkg,
        frameworks: detectFrameworks(pkg, scan.files),
        entrypoints: detectEntrypoints(scan.files, pkg),
        directories: groupByDirectory(scan.files),
        fileStats: {
          filesScanned: scan.files.length,
          directoriesVisited: scan.directoriesVisited,
          byExtension: extensionStats(scan.files),
          truncated: scan.truncated,
        },
        symbolStats: countSymbolsByKind(symbols),
        exportedSymbols: symbols.filter((symbol) => symbol.exported).slice(0, 80),
        dependencyHotspots: hotspots,
      };
    },
  };
}

export function createSymbolSearchTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "symbol_search",
      description: "Search functions, classes, interfaces, types, variables, structs, enums, and traits across workspace code files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string" },
          limit: { type: "number" },
          includeTests: { type: "boolean" },
        },
        required: ["query"],
      },
      risk: "read",
      requiresApproval: false,
      capability: "code.symbols",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      if (!input || typeof input !== "object") throw new Error("symbol_search: input must be { query, kind?, limit? }");
      const obj = input as Record<string, unknown>;
      if (typeof obj.query !== "string" || !obj.query.trim()) throw new Error("symbol_search: query is required");
      const query = obj.query.trim().toLowerCase();
      const limit = normalizeLimit(obj.limit, 20, 100);
      const kind = typeof obj.kind === "string" ? obj.kind : null;
      const scan = scanCodeFiles(workspaceRoot, {
        maxFiles: DEFAULT_SCAN_LIMIT,
        includeTests: typeof obj.includeTests === "boolean" ? obj.includeTests : true,
      }, context);
      const matches: CodeSymbol[] = [];
      for (const file of scan.files) {
        for (const symbol of extractSymbols(file, readTextFile(file))) {
          if (kind && symbol.kind !== kind) continue;
          if (!symbol.name.toLowerCase().includes(query) && !symbol.signature.toLowerCase().includes(query)) continue;
          matches.push(symbol);
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      return {
        query: obj.query,
        kind,
        results: matches,
        truncated: matches.length >= limit || scan.truncated,
        filesScanned: scan.files.length,
      };
    },
  };
}

export function createDependencyGraphTool(workspaceRoot: string): Tool {
  return {
    descriptor: {
      name: "dependency_graph",
      description: "Extract a lightweight import/use dependency graph from code files. Returns local edges, package imports, and dependency hotspots.",
      inputSchema: {
        type: "object",
        properties: {
          maxFiles: { type: "number" },
          includePackages: { type: "boolean" },
          includeTests: { type: "boolean" },
        },
      },
      risk: "read",
      requiresApproval: false,
      capability: "code.dependencies",
    },
    async execute(input: unknown, context?: ToolExecutionContext): Promise<unknown> {
      const obj = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const includePackages = obj.includePackages !== false;
      const scan = scanCodeFiles(workspaceRoot, {
        maxFiles: normalizeLimit(obj.maxFiles, DEFAULT_SCAN_LIMIT, 5_000),
        includeTests: typeof obj.includeTests === "boolean" ? obj.includeTests : true,
      }, context);
      const edges: DependencyEdge[] = [];
      for (const file of scan.files) {
        edges.push(...extractDependencies(file, readTextFile(file)));
      }
      const localEdges = edges.filter((edge) => edge.kind === "local");
      const packageEdges = edges.filter((edge) => edge.kind === "package" || edge.kind === "builtin");
      return {
        workspaceRoot,
        filesScanned: scan.files.length,
        truncated: scan.truncated,
        localEdges: localEdges.slice(0, 300),
        ...(includePackages ? { packageImports: countEdges(packageEdges).slice(0, 80) } : {}),
        hotspots: countEdges(edges).slice(0, 50),
      };
    },
  };
}

function countSymbolsByKind(symbols: CodeSymbol[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const symbol of symbols) {
    counts[symbol.kind] = (counts[symbol.kind] ?? 0) + 1;
  }
  return counts;
}

function countEdges(edges: DependencyEdge[]): Array<{ target: string; imports: number; kind: DependencyEdge["kind"] }> {
  const counts = new Map<string, { imports: number; kind: DependencyEdge["kind"] }>();
  for (const edge of edges) {
    const key = `${edge.kind}:${edge.to}`;
    const current = counts.get(key) ?? { imports: 0, kind: edge.kind };
    current.imports += 1;
    counts.set(key, current);
  }
  return Array.from(counts.entries())
    .map(([key, value]) => ({ target: key.replace(/^[^:]+:/, ""), imports: value.imports, kind: value.kind }))
    .sort((a, b) => b.imports - a.imports || a.target.localeCompare(b.target));
}

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(process.cwd());
const sourceRoots = ["src", "electron", join("ui", "src")];
const sourceExtensions = new Set([".ts", ".tsx"]);
const ignoredDirectories = new Set(["node_modules", "dist", "desktop-build", "release", ".git"]);

function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolute));
    else if (sourceExtensions.has(extname(entry.name))) files.push(absolute);
  }
  return files;
}

function areaForPath(absolutePath) {
  const path = relative(projectRoot, absolutePath).split(sep).join("/");
  if (path.startsWith("ui/src/")) return "ui";
  if (path.startsWith("electron/")) return "electron";
  if (path.startsWith("src/")) return path.split("/").slice(0, 2).join("/");
  if (path.startsWith("dist/")) return `src/${path.split("/")[1] ?? "unknown"}`;
  return "external";
}

function countLines(content) {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function importedArea(file, specifier) {
  if (!specifier.startsWith(".")) return "external";
  return areaForPath(resolve(file, "..", specifier));
}

const files = sourceRoots.flatMap((root) => collectFiles(join(projectRoot, root)));
const records = files.map((absolutePath) => {
  const content = readFileSync(absolutePath, "utf8");
  const imports = [...content.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1]);
  return {
    path: relative(projectRoot, absolutePath).split(sep).join("/"),
    area: areaForPath(absolutePath),
    lines: countLines(content),
    isTest: /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(absolutePath),
    testCases: [...content.matchAll(/\b(?:test|it)\s*\(/g)].length,
    imports: imports.map((specifier) => importedArea(absolutePath, specifier)),
  };
});

const production = records.filter((record) => !record.isTest);
const tests = records.filter((record) => record.isTest);
const areaTotals = new Map();
const dependencyDirections = new Map();

for (const record of records) {
  const total = areaTotals.get(record.area) ?? { files: 0, lines: 0, testFiles: 0, testCases: 0 };
  total.files += 1;
  total.lines += record.lines;
  total.testFiles += Number(record.isTest);
  total.testCases += record.isTest ? record.testCases : 0;
  areaTotals.set(record.area, total);

  for (const target of record.imports) {
    if (target === "external" || target === record.area) continue;
    const direction = `${record.area} -> ${target}`;
    dependencyDirections.set(direction, (dependencyDirections.get(direction) ?? 0) + 1);
  }
}

const metrics = {
  generatedAt: new Date().toISOString(),
  sourceRevision: process.env.GITHUB_SHA ?? "working-tree",
  files: records.length,
  productionFiles: production.length,
  sourceLines: records.reduce((sum, record) => sum + record.lines, 0),
  productionLines: production.reduce((sum, record) => sum + record.lines, 0),
  testFiles: tests.length,
  testCases: tests.reduce((sum, record) => sum + record.testCases, 0),
  coverage: "not-configured",
  largestProductionModules: production
    .toSorted((left, right) => right.lines - left.lines)
    .slice(0, 15)
    .map(({ path, area, lines }) => ({ path, area, lines })),
  areaTotals: Object.fromEntries([...areaTotals.entries()].toSorted(([left], [right]) => left.localeCompare(right))),
  dependencyDirections: Object.fromEntries(
    [...dependencyDirections.entries()].toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  ),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
} else {
  process.stdout.write([
    `Source files: ${metrics.files} (${metrics.productionFiles} production, ${metrics.testFiles} test)`,
    `Source lines: ${metrics.sourceLines} (${metrics.productionLines} production)`,
    `Test cases: ${metrics.testCases}`,
    `Coverage: ${metrics.coverage}`,
    "Largest production modules:",
    ...metrics.largestProductionModules.map((entry) => `  ${entry.lines.toString().padStart(5)}  ${entry.path}`),
    "Dependency directions:",
    ...Object.entries(metrics.dependencyDirections).map(([direction, count]) => `  ${count.toString().padStart(4)}  ${direction}`),
    "",
  ].join("\n"));
}

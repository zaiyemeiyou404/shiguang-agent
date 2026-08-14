import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";

const USER_DATA_DIR_NAME = "shiguang-agent-data";
const LEGACY_APP_DATA_DIRS = ["shiguang-agent"];
const LEGACY_ELECTRON_FILES = [
  "shiguang-state.sqlite",
  "shiguang-state.sqlite-shm",
  "shiguang-state.sqlite-wal",
  "shiguang-state.sqlite-journal",
  "shiguang-store.json",
  "shiguang.config.json",
  "memory/shiguang-memory.sqlite",
  "memory/shiguang-memory.sqlite-shm",
  "memory/shiguang-memory.sqlite-wal",
  "memory/shiguang-memory.sqlite-journal",
];
const MIGRATION_MARKER = ".migrated-from-appdata";

export function configureAppUserDataPath(): string {
  const targetPath = resolveShiguangUserDataPath();
  mkdirSync(targetPath, { recursive: true });
  migrateBuildOutputUserData(targetPath);
  migrateLegacyUserData(targetPath);
  app.setPath("userData", targetPath);
  return targetPath;
}

export function resolveShiguangUserDataPath(): string {
  const override = process.env.SHIGUANG_USER_DATA_DIR ?? process.env.SHIGUANG_DATA_DIR;
  if (override?.trim()) {
    return resolve(normalize(override));
  }

  if (app.isPackaged) return resolvePackagedUserDataPath();

  return join(resolveProjectRoot(), USER_DATA_DIR_NAME);
}

function resolvePackagedUserDataPath(): string {
  const execDir = dirname(process.execPath);
  const buildOutputProjectRoot = resolveBuildOutputProjectRoot(execDir);
  if (buildOutputProjectRoot) {
    return join(buildOutputProjectRoot, USER_DATA_DIR_NAME);
  }

  const preferredDataRoot = resolvePreferredWindowsDataRoot();
  if (preferredDataRoot) {
    return join(preferredDataRoot, "shiguang-agent-data");
  }

  return join(execDir, USER_DATA_DIR_NAME);
}

function resolveBuildOutputProjectRoot(execDir: string): string | null {
  const unpackedDir = basename(execDir).toLowerCase();
  const releaseDir = dirname(execDir);
  if ((unpackedDir === "win-unpacked" || unpackedDir === "linux-unpacked") && basename(releaseDir).toLowerCase() === "release") {
    return dirname(releaseDir);
  }
  return null;
}

function resolvePreferredWindowsDataRoot(): string | null {
  if (process.platform !== "win32") return null;
  const gCodexData = "G:\\CodexData";
  if (!existsSync("G:\\")) return null;
  mkdirSync(gCodexData, { recursive: true });
  return gCodexData;
}

function resolveProjectRoot(): string {
  const appPath = app.getAppPath();
  return basename(appPath) === "desktop-build" ? dirname(appPath) : appPath;
}

function migrateBuildOutputUserData(targetPath: string): void {
  if (!app.isPackaged) return;
  const sourcePath = join(dirname(process.execPath), USER_DATA_DIR_NAME);
  if (resolve(sourcePath).toLowerCase() === resolve(targetPath).toLowerCase()) return;
  migrateLegacyDirectory(sourcePath, targetPath, false);
}

function migrateLegacyUserData(targetPath: string): void {
  const markerPath = join(targetPath, MIGRATION_MARKER);
  if (existsSync(markerPath)) return;

  const appDataPath = process.env.APPDATA || app.getPath("appData");
  for (const legacyName of LEGACY_APP_DATA_DIRS) {
    migrateLegacyDirectory(join(appDataPath, legacyName), targetPath, true);
  }
  migrateLegacyDirectory(join(appDataPath, "Electron"), targetPath, false);

  try {
    writeFileSync(markerPath, `migrated at ${new Date().toISOString()}\n`, "utf8");
  } catch {
    // Migration is best effort; failing to write the marker must not block startup.
  }
}

function migrateLegacyDirectory(sourcePath: string, targetPath: string, removeWholeDirectory: boolean): void {
  if (!existsSync(sourcePath)) return;
  if (resolve(sourcePath).toLowerCase() === resolve(targetPath).toLowerCase()) return;

  for (const fileName of LEGACY_ELECTRON_FILES) {
    const sourceFile = join(sourcePath, fileName);
    const targetFile = join(targetPath, fileName);
    if (!existsSync(sourceFile) || existsSync(targetFile)) continue;
    try {
      mkdirSync(dirname(targetFile), { recursive: true });
      copyFileSync(sourceFile, targetFile);
      rmSync(sourceFile, { force: true });
    } catch (error) {
      console.warn(`Failed to migrate ${sourceFile}:`, error);
    }
  }

  if (removeWholeDirectory) {
    tryRemoveDirectory(sourcePath);
  } else {
    tryRemoveKnownEmptyDirectory(sourcePath);
  }
}

function tryRemoveDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to remove legacy data directory ${path}:`, error);
  }
}

function tryRemoveKnownEmptyDirectory(path: string): void {
  try {
    const entries = readdirSync(path);
    if (entries.length === 0 || entries.every((entry) => LEGACY_ELECTRON_FILES.includes(entry))) {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Keep generic Electron data directories if another dev app is using them.
  }
}

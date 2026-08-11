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
];
const MIGRATION_MARKER = ".migrated-from-appdata";

export function configureAppUserDataPath(): string {
  const targetPath = resolveShiguangUserDataPath();
  mkdirSync(targetPath, { recursive: true });
  migrateLegacyUserData(targetPath);
  app.setPath("userData", targetPath);
  return targetPath;
}

export function resolveShiguangUserDataPath(): string {
  const override = process.env.SHIGUANG_USER_DATA_DIR ?? process.env.SHIGUANG_DATA_DIR;
  if (override?.trim()) {
    return resolve(normalize(override));
  }

  if (app.isPackaged) {
    return join(dirname(process.execPath), USER_DATA_DIR_NAME);
  }

  return join(resolveProjectRoot(), USER_DATA_DIR_NAME);
}

function resolveProjectRoot(): string {
  const appPath = app.getAppPath();
  return basename(appPath) === "desktop-build" ? dirname(appPath) : appPath;
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

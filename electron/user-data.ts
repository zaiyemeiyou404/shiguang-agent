import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  SHIGUANG_LEGACY_RUNTIME_FILES,
  describeWorkspacePolicy,
  resolveWorkspacePolicy,
  type WorkspacePolicy,
} from "../dist/workspace/policy.js";

export function configureAppUserDataPath(): string {
  const policy = getShiguangWorkspacePolicy();
  const targetPath = policy.userDataRoot;
  mkdirSync(targetPath, { recursive: true });
  migratePackagedExecutableUserData(policy);
  migrateLegacyUserData(policy);
  app.setPath("userData", targetPath);
  console.log(`Shiguang workspace policy: ${describeWorkspacePolicy(policy)}`);
  return targetPath;
}

export function resolveShiguangUserDataPath(): string {
  return getShiguangWorkspacePolicy().userDataRoot;
}

export function getShiguangWorkspacePolicy(): WorkspacePolicy {
  return resolveWorkspacePolicy({
    env: process.env,
    appPath: app.getAppPath(),
    execPath: process.execPath,
    appDataPath: process.env.APPDATA || app.getPath("appData"),
    isPackaged: app.isPackaged,
    preferredDataRoot: resolvePreferredWindowsDataRoot(),
  });
}

function resolvePreferredWindowsDataRoot(): string | null {
  if (process.platform !== "win32") return null;
  const gCodexData = "G:\\CodexData";
  if (!existsSync("G:\\")) return null;
  mkdirSync(gCodexData, { recursive: true });
  return gCodexData;
}

function migratePackagedExecutableUserData(policy: WorkspacePolicy): void {
  if (!app.isPackaged) return;
  const sourcePath = policy.packagedExecutableDataRoot;
  if (!sourcePath) return;
  const targetPath = policy.userDataRoot;
  if (resolve(sourcePath).toLowerCase() === resolve(targetPath).toLowerCase()) return;
  migrateLegacyDirectory(sourcePath, targetPath, false, SHIGUANG_LEGACY_RUNTIME_FILES);
}

function migrateLegacyUserData(policy: WorkspacePolicy): void {
  if (existsSync(policy.migrationMarkerPath)) return;

  for (const source of policy.legacyUserDataSources) {
    migrateLegacyDirectory(source.path, policy.userDataRoot, source.removeWholeDirectory, source.files);
  }

  try {
    writeFileSync(policy.migrationMarkerPath, `migrated at ${new Date().toISOString()}\n`, "utf8");
  } catch {
    // Migration is best effort; failing to write the marker must not block startup.
  }
}

function migrateLegacyDirectory(
  sourcePath: string,
  targetPath: string,
  removeWholeDirectory: boolean,
  files: readonly string[],
): void {
  if (!existsSync(sourcePath)) return;
  if (resolve(sourcePath).toLowerCase() === resolve(targetPath).toLowerCase()) return;

  for (const fileName of files) {
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
    tryRemoveKnownEmptyDirectory(sourcePath, files);
  }
}

function tryRemoveDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to remove legacy data directory ${path}:`, error);
  }
}

function tryRemoveKnownEmptyDirectory(path: string, files: readonly string[]): void {
  try {
    const entries = readdirSync(path);
    if (entries.length === 0 || entries.every((entry) => files.includes(entry))) {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Keep generic Electron data directories if another dev app is using them.
  }
}

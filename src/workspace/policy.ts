import { basename, dirname, join, normalize, resolve } from "node:path";

export const WORKSPACE_POLICY_VERSION = "shiguang.workspace.policy.v1" as const;
export const SHIGUANG_USER_DATA_DIR_NAME = "shiguang-agent-data";
export const SHIGUANG_DEFAULT_WORKSPACE_DIR_NAME = "workspace";
export const SHIGUANG_MEMORY_DIR_NAME = "memory";

export const SHIGUANG_LEGACY_RUNTIME_FILES = [
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
] as const;

export type WorkspacePolicySource =
  | "env"
  | "development_project"
  | "packaged_build_output"
  | "packaged_preferred_root"
  | "packaged_executable";

export interface WorkspacePolicyInput {
  env?: Record<string, string | undefined>;
  appPath: string;
  execPath: string;
  appDataPath?: string;
  isPackaged: boolean;
  preferredDataRoot?: string | null;
}

export interface WorkspaceRootInput {
  env?: Record<string, string | undefined>;
  userDataRoot: string;
  configuredWorkspaceRoot?: string;
}

export interface LegacyUserDataSource {
  path: string;
  removeWholeDirectory: boolean;
  files: readonly string[];
}

export interface WorkspacePolicy {
  version: typeof WORKSPACE_POLICY_VERSION;
  userDataRoot: string;
  userDataRootSource: WorkspacePolicySource;
  projectRoot: string;
  executableDir: string;
  packagedExecutableDataRoot: string | null;
  configPath: string;
  storePath: string;
  stateDbPath: string;
  memoryDir: string;
  memoryDbPath: string;
  defaultWorkspaceRoot: string;
  migrationMarkerPath: string;
  legacyUserDataSources: LegacyUserDataSource[];
}

export function resolveWorkspacePolicy(input: WorkspacePolicyInput): WorkspacePolicy {
  const env = input.env ?? {};
  const projectRoot = resolveProjectRootFromAppPath(input.appPath);
  const executableDir = dirname(resolve(normalize(input.execPath)));
  const userDataResolution = resolveUserDataRoot({
    env,
    isPackaged: input.isPackaged,
    appPath: input.appPath,
    execPath: input.execPath,
    preferredDataRoot: input.preferredDataRoot,
  });
  const userDataRoot = userDataResolution.path;

  return {
    version: WORKSPACE_POLICY_VERSION,
    userDataRoot,
    userDataRootSource: userDataResolution.source,
    projectRoot,
    executableDir,
    packagedExecutableDataRoot: input.isPackaged ? join(executableDir, SHIGUANG_USER_DATA_DIR_NAME) : null,
    configPath: join(userDataRoot, "shiguang.config.json"),
    storePath: join(userDataRoot, "shiguang-store.json"),
    stateDbPath: join(userDataRoot, "shiguang-state.sqlite"),
    memoryDir: join(userDataRoot, SHIGUANG_MEMORY_DIR_NAME),
    memoryDbPath: join(userDataRoot, SHIGUANG_MEMORY_DIR_NAME, "shiguang-memory.sqlite"),
    defaultWorkspaceRoot: join(userDataRoot, SHIGUANG_DEFAULT_WORKSPACE_DIR_NAME),
    migrationMarkerPath: join(userDataRoot, ".migrated-from-appdata"),
    legacyUserDataSources: resolveLegacyUserDataSources(input.appDataPath),
  };
}

export function resolveWorkspaceRootFromPolicy(input: WorkspaceRootInput): string {
  const env = input.env ?? {};
  return resolve(normalize(
    env.SHIGUANG_WORKSPACE_ROOT
    ?? input.configuredWorkspaceRoot
    ?? join(input.userDataRoot, SHIGUANG_DEFAULT_WORKSPACE_DIR_NAME),
  ));
}

export function resolveConfigPathFromPolicy(
  policy: Pick<WorkspacePolicy, "configPath">,
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SHIGUANG_CONFIG_PATH?.trim()
    ? resolve(normalize(env.SHIGUANG_CONFIG_PATH))
    : policy.configPath;
}

export function describeWorkspacePolicy(policy: WorkspacePolicy): string {
  return [
    `policy=${policy.version}`,
    `source=${policy.userDataRootSource}`,
    `userData=${policy.userDataRoot}`,
    `workspace=${policy.defaultWorkspaceRoot}`,
    `memory=${policy.memoryDbPath}`,
  ].join("; ");
}

export function resolveProjectRootFromAppPath(appPath: string): string {
  const resolved = resolve(normalize(appPath));
  return basename(resolved) === "desktop-build" ? dirname(resolved) : resolved;
}

function resolveUserDataRoot(input: {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  appPath: string;
  execPath: string;
  preferredDataRoot?: string | null;
}): { path: string; source: WorkspacePolicySource } {
  const override = input.env.SHIGUANG_USER_DATA_DIR ?? input.env.SHIGUANG_DATA_DIR;
  if (override?.trim()) {
    return { path: resolve(normalize(override)), source: "env" };
  }

  if (!input.isPackaged) {
    return {
      path: join(resolveProjectRootFromAppPath(input.appPath), SHIGUANG_USER_DATA_DIR_NAME),
      source: "development_project",
    };
  }

  const buildOutputProjectRoot = resolveBuildOutputProjectRoot(dirname(resolve(normalize(input.execPath))));
  if (buildOutputProjectRoot) {
    return {
      path: join(buildOutputProjectRoot, SHIGUANG_USER_DATA_DIR_NAME),
      source: "packaged_build_output",
    };
  }

  if (input.preferredDataRoot?.trim()) {
    return {
      path: join(resolve(normalize(input.preferredDataRoot)), SHIGUANG_USER_DATA_DIR_NAME),
      source: "packaged_preferred_root",
    };
  }

  return {
    path: join(dirname(resolve(normalize(input.execPath))), SHIGUANG_USER_DATA_DIR_NAME),
    source: "packaged_executable",
  };
}

function resolveBuildOutputProjectRoot(execDir: string): string | null {
  const unpackedDir = basename(execDir).toLowerCase();
  const releaseDir = dirname(execDir);
  if ((unpackedDir === "win-unpacked" || unpackedDir === "linux-unpacked") && basename(releaseDir).toLowerCase() === "release") {
    return dirname(releaseDir);
  }
  return null;
}

function resolveLegacyUserDataSources(appDataPath: string | undefined): LegacyUserDataSource[] {
  if (!appDataPath?.trim()) return [];
  const appDataRoot = resolve(normalize(appDataPath));
  return [
    {
      path: join(appDataRoot, "shiguang-agent"),
      removeWholeDirectory: true,
      files: SHIGUANG_LEGACY_RUNTIME_FILES,
    },
    {
      path: join(appDataRoot, "Electron"),
      removeWholeDirectory: false,
      files: SHIGUANG_LEGACY_RUNTIME_FILES,
    },
  ];
}

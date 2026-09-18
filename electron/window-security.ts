import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, Event, HandlerDetails, WebContents } from "electron";

export const DEVELOPMENT_RENDERER_URL = "http://localhost:5173";

export interface WindowResources {
  preloadPath: string;
  uiEntry: string;
  rendererUrl: string;
}
export interface ExternalUrlOpener {
  openExternal(url: string): Promise<void>;
}

export function resolveWindowResources(appPath: string, isDev: boolean): WindowResources {
  const projectRoot = basename(appPath) === "desktop-build" ? dirname(appPath) : appPath;
  const desktopBuildDir = basename(appPath) === "desktop-build" ? appPath : join(appPath, "desktop-build");
  const uiEntry = join(projectRoot, "ui", "dist", "index.html");
  return {
    preloadPath: join(desktopBuildDir, "preload.cjs"),
    uiEntry,
    rendererUrl: isDev ? DEVELOPMENT_RENDERER_URL : pathToFileURL(uiEntry).href,
  };
}

export function createSecureWebPreferences(preloadPath: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  } as const;
}

export function isTrustedRendererUrl(url: string, resources: WindowResources, isDev: boolean): boolean {
  try {
    const candidate = new URL(url);
    if (isDev) return candidate.origin === new URL(DEVELOPMENT_RENDERER_URL).origin;
    const entry = new URL(pathToFileURL(resolve(resources.uiEntry)).href);
    return candidate.protocol === "file:" && decodeURIComponent(candidate.pathname) === decodeURIComponent(entry.pathname);
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function contentSecurityPolicy(isDev: boolean): string {
  const connectSources = isDev
    ? "'self' http://localhost:5173 ws://localhost:5173 https:"
    : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function installWindowSecurity(
  win: BrowserWindow,
  resources: WindowResources,
  isDev: boolean,
  externalUrlOpener: ExternalUrlOpener,
): void {
  win.webContents.setWindowOpenHandler(({ url }: HandlerDetails) => {
    if (isAllowedExternalUrl(url)) void externalUrlOpener.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event: Event, url: string) => {
    if (isTrustedRendererUrl(url, resources, isDev)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void externalUrlOpener.openExternal(url);
  });

  installContentSecurityPolicy(win.webContents, contentSecurityPolicy(isDev));
}

function installContentSecurityPolicy(webContents: WebContents, policy: string): void {
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

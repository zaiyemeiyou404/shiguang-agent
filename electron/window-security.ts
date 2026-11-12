import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, Event, HandlerDetails, WebContents } from "electron";

export const DEVELOPMENT_RENDERER_URL = "http://localhost:5173";
export const CAMPUS_CARD_ORIGIN = "http://127.0.0.1:47321";

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
  // Vite's React refresh preamble is an inline module script. Allow it only
  // while the development server is serving the renderer.
  const scriptSources = isDev ? "'self' 'unsafe-inline'" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'self'",
    `frame-src ${CAMPUS_CARD_ORIGIN}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

export function retainsOwnContentSecurityPolicy(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === CAMPUS_CARD_ORIGIN;
  } catch {
    return false;
  }
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
    if (retainsOwnContentSecurityPolicy(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

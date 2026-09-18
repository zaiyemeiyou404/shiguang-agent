import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import {
  DEVELOPMENT_RENDERER_URL,
  contentSecurityPolicy,
  createSecureWebPreferences,
  installWindowSecurity,
  isTrustedRendererUrl,
  resolveWindowResources,
} from "./window-security.js";

describe("desktop window security and loading contract", () => {
  it("resolves development and packaged resources with isolated renderer preferences", () => {
    const development = resolveWindowResources(join("G:", "repo", "desktop-build"), true);
    expect(development).toMatchObject({
      preloadPath: join("G:", "repo", "desktop-build", "preload.cjs"),
      uiEntry: join("G:", "repo", "ui", "dist", "index.html"),
      rendererUrl: DEVELOPMENT_RENDERER_URL,
    });
    expect(createSecureWebPreferences(development.preloadPath)).toEqual({
      preload: development.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });

    const packaged = resolveWindowResources(join("G:", "installed", "resources", "app.asar"), false);
    expect(packaged.rendererUrl.startsWith("file:")).toBe(true);
    expect(isTrustedRendererUrl(packaged.rendererUrl, packaged, false)).toBe(true);
    expect(isTrustedRendererUrl("https://example.com", packaged, false)).toBe(false);
    expect(isTrustedRendererUrl(`${DEVELOPMENT_RENDERER_URL}/src/main.tsx`, development, true)).toBe(true);
  });

  it("blocks unexpected navigation and windows while opening safe external URLs out of process", async () => {
    let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
    let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let headersHandler: ((details: { responseHeaders?: Record<string, string[]> }, callback: (result: { responseHeaders?: Record<string, string[]> }) => void) => void) | undefined;
    const openExternal = vi.fn(async () => {});
    const resources = resolveWindowResources(join("G:", "repo", "desktop-build"), true);
    const win = {
      webContents: {
        setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; },
        on: (_event: string, handler: typeof navigateHandler) => { navigateHandler = handler; },
        session: {
          webRequest: {
            onHeadersReceived: (handler: typeof headersHandler) => { headersHandler = handler; },
          },
        },
      },
    } as unknown as BrowserWindow;

    installWindowSecurity(win, resources, true, { openExternal });
    expect(openHandler?.({ url: "https://example.com/docs" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });

    const preventDefault = vi.fn();
    navigateHandler?.({ preventDefault }, "https://example.com/docs");
    expect(preventDefault).toHaveBeenCalledOnce();
    navigateHandler?.({ preventDefault }, `${DEVELOPMENT_RENDERER_URL}/settings`);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledTimes(2);

    let responseHeaders: Record<string, string[]> | undefined;
    headersHandler?.({ responseHeaders: { Existing: ["value"] } }, (result) => { responseHeaders = result.responseHeaders; });
    expect(responseHeaders?.["Content-Security-Policy"]?.[0]).toBe(contentSecurityPolicy(true));
    expect(contentSecurityPolicy(false)).toContain("script-src 'self'");
    expect(contentSecurityPolicy(false)).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

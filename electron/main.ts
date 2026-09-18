import { app, BrowserWindow, Menu, shell } from "electron";
import * as path from "node:path";
import { DesktopStore } from "./store.js";
import { DesktopAppService } from "./app-service.js";
import { registerIpcHandlers } from "./ipc.js";
import { configureAppUserDataPath } from "./user-data.js";
import {
  startLocalAgentGateway,
  type LocalAgentGatewayHandle,
} from "../dist/integrations/local-agent-gateway.js";
import {
  createSecureWebPreferences,
  installWindowSecurity,
  resolveWindowResources,
} from "./window-security.js";

const isDev = process.env.ELECTRON_DEV === "true";
const userDataPath = configureAppUserDataPath();
let service: DesktopAppService;
let localAgentGateway: LocalAgentGatewayHandle | null = null;

function createWindow() {
  const appPath = app.getAppPath();
  const resources = resolveWindowResources(appPath, isDev);
  const win = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: "拾光 Agent",
    autoHideMenuBar: true,
    webPreferences: createSecureWebPreferences(resources.preloadPath),
  });
  installWindowSecurity(win, resources, isDev, shell);

  if (isDev) {
    win.loadURL(resources.rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(resources.uiEntry);
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  console.log(`Shiguang Agent user data: ${userDataPath}`);
  const store = new DesktopStore();
  service = new DesktopAppService(store);
  registerIpcHandlers(service);
  try {
    localAgentGateway = await startLocalAgentGateway(service, {
      host: "127.0.0.1",
      port: resolveGatewayPort(process.env.SHIGUANG_LOCAL_AGENT_PORT),
      token: process.env.SHIGUANG_LOCAL_AGENT_TOKEN,
      discoveryFile: path.join(userDataPath, "local-agent-gateway.json"),
    });
  } catch (error) {
    console.error("Failed to start the local XDYou Agent gateway:", error);
  }
  createWindow();
});

app.on("window-all-closed", () => {
  void localAgentGateway?.close();
  app.quit();
});

function resolveGatewayPort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

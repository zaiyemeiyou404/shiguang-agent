import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { DesktopStore } from "./store.js";
import { DesktopAppService } from "./app-service.js";
import { registerIpcHandlers } from "./ipc.js";
import { configureAppUserDataPath } from "./user-data.js";
import {
  startLocalAgentGateway,
  type LocalAgentGatewayHandle,
} from "../dist/integrations/local-agent-gateway.js";

const isDev = process.env.ELECTRON_DEV === "true";
const userDataPath = configureAppUserDataPath();
let service: DesktopAppService;
let localAgentGateway: LocalAgentGatewayHandle | null = null;

function createWindow() {
  const appPath = app.getAppPath();
  const projectRoot = path.basename(appPath) === "desktop-build" ? path.dirname(appPath) : appPath;
  const desktopBuildDir = path.basename(appPath) === "desktop-build" ? appPath : path.join(appPath, "desktop-build");
  const preloadPath = path.join(desktopBuildDir, "preload.cjs");
  const uiEntry = path.join(projectRoot, "ui", "dist", "index.html");
  const win = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: "拾光 Agent",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(uiEntry);
  }
}

app.whenReady().then(async () => {
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

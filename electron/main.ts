import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { DesktopStore } from "./store.js";
import { DesktopAppService } from "./app-service.js";
import { registerIpcHandlers } from "./ipc.js";

const isDev = process.env.ELECTRON_DEV === "true";
let service: DesktopAppService;

function createWindow() {
  const appPath = app.getAppPath();
  const projectRoot = path.basename(appPath) === "desktop-build" ? path.dirname(appPath) : appPath;
  const desktopBuildDir = path.basename(appPath) === "desktop-build" ? appPath : path.join(appPath, "desktop-build");
  const preloadPath = path.join(desktopBuildDir, "preload.js");
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

app.whenReady().then(() => {
  const store = new DesktopStore();
  service = new DesktopAppService(store);
  registerIpcHandlers(service);
  createWindow();
});

app.on("window-all-closed", () => app.quit());

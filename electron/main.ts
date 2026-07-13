import { app, BrowserWindow } from "electron";
import path from "node:path";
import { DesktopStore } from "./store.js";
import { DesktopAppService } from "./app-service.js";
import { registerIpcHandlers } from "./ipc.js";

const isDev = process.env.ELECTRON_DEV === "true";
let service: DesktopAppService;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: "拾光 Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../ui/dist/index.html"));
  }
}

app.whenReady().then(() => {
  const store = new DesktopStore();
  service = new DesktopAppService(store);
  registerIpcHandlers(service);
  createWindow();
});

app.on("window-all-closed", () => app.quit());

import { contextBridge, ipcRenderer } from "electron";
import { createShiguangBridge } from "./preload-bridge.js";

contextBridge.exposeInMainWorld("shiguang", createShiguangBridge(ipcRenderer));

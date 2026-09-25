import type { DesktopBridge, DesktopBrowserEvent, UpdateStatus } from "@apcode/contracts";
import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";

const dropListeners = new Set<(paths: ReadonlyArray<string>) => void>();

window.addEventListener("dragover", (event) => {
  if (dropListeners.size > 0 && event.dataTransfer?.types.includes("Files")) event.preventDefault();
});

window.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (dropListeners.size === 0 || files.length === 0) return;
  event.preventDefault();
  for (const listener of dropListeners)
    listener(files.map((file) => webUtils.getPathForFile(file)));
});

contextBridge.exposeInMainWorld("desktop", {
  daemon: () => ipcRenderer.invoke("daemon"),
  pickFolder: (title, defaultPath) => ipcRenderer.invoke("pick-folder", { title, defaultPath }),
  pickFiles: (title) => ipcRenderer.invoke("pick-files", title),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  onFileDrop: (listener) => {
    dropListeners.add(listener);
    return () => dropListeners.delete(listener);
  },
  onBrowserEvent: (listener) => {
    function forward(_event: IpcRendererEvent, browserEvent: DesktopBrowserEvent) {
      listener(browserEvent);
    }
    ipcRenderer.on("browser-event", forward);
    return () => ipcRenderer.removeListener("browser-event", forward);
  },
  automateBrowser: (webContentsId, action) =>
    ipcRenderer.invoke("automate-browser", { webContentsId, action }),
  appVersion: () => ipcRenderer.invoke("app-version"),
  updateStatus: () => ipcRenderer.invoke("update-status"),
  onUpdateStatus: (listener) => {
    function forward(_event: IpcRendererEvent, status: UpdateStatus) {
      listener(status);
    }
    ipcRenderer.on("update-status-changed", forward);
    return () => ipcRenderer.removeListener("update-status-changed", forward);
  },
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
} satisfies DesktopBridge);

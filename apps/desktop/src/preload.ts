import type { DesktopBridge } from "@apcode/contracts";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const dropListeners = new Set<(paths: ReadonlyArray<string>) => void>();

window.addEventListener("dragover", (event) => {
  if (dropListeners.size > 0 && event.dataTransfer?.types.includes("Files")) event.preventDefault();
});

window.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (dropListeners.size === 0 || files.length === 0) return;
  event.preventDefault();
  for (const listener of dropListeners) listener(files.map((file) => webUtils.getPathForFile(file)));
});

contextBridge.exposeInMainWorld("desktop", {
  daemonToken: () => ipcRenderer.invoke("daemon-token"),
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", title),
  pickFiles: (title) => ipcRenderer.invoke("pick-files", title),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  onFileDrop: (listener) => {
    dropListeners.add(listener);
    return () => dropListeners.delete(listener);
  },
} satisfies DesktopBridge);

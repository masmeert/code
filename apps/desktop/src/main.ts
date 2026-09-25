import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { registerBridge } from "./bridge.ts";
import { APP_URL, registerRendererScheme, serveRenderer } from "./renderer.ts";
import { createWindow } from "./windows.ts";

const daemonToken = app.isPackaged ? randomBytes(32).toString("hex") : null;
const daemon = daemonToken
  ? spawn(join(process.resourcesPath, "apcode-daemon"), { env: { ...process.env, APCODE_TOKEN: daemonToken }, stdio: "ignore" })
  : null;

function checkForUpdates() {
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

registerRendererScheme();
registerBridge(daemonToken);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => daemon?.kill());

app
  .whenReady()
  .then(() => {
    serveRenderer();
    createWindow(APP_URL);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(APP_URL);
    });
    if (!app.isPackaged) return;
    checkForUpdates();
    setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
  })
  .catch(() => app.quit());

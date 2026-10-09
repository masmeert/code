import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BROWSER_PARTITION } from "@masscode/contracts";
import { app, BrowserWindow, session } from "electron";
import { registerBridge } from "./bridge.ts";
import { configureBrowserSession } from "./browser.ts";
import { freePort } from "./freePort.ts";
import { closeTunnels, loadHosts } from "./hosts.ts";
import { APP_URL, registerRendererScheme, serveRenderer } from "./renderer.ts";
import { watchForUpdates } from "./updates.ts";
import { createWindow } from "./windows.ts";

const daemonToken = randomBytes(32).toString("hex");
let daemon: ChildProcess | null = null;
let daemonPort: Promise<number> | null = null;
let quitting = false;

// A fixed port let a daemon left over from an earlier launch (or a dev daemon) hold it,
// so ours failed to bind and the app waited on a daemon that rejects its token.
function startDaemon() {
  daemonPort = freePort().then((port) => {
    daemon = spawn(join(process.resourcesPath, "masscode-daemon"), {
      env: { ...process.env, MASSCODE_TOKEN: daemonToken, MASSCODE_PORT: String(port) },
      stdio: "ignore",
    });
    // ponytail: fixed 1s respawn, add backoff if a daemon that always crashes becomes a problem
    daemon.once("exit", () => {
      if (!quitting) setTimeout(startDaemon, 1000);
    });
    return port;
  });
}

if (app.isPackaged) startDaemon();

registerRendererScheme();
registerBridge(() => daemonPort?.then((port) => ({ port, token: daemonToken })) ?? null);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  quitting = true;
  daemon?.kill();
  closeTunnels();
});

app
  .whenReady()
  .then(async () => {
    await loadHosts();
    serveRenderer();
    configureBrowserSession(session.fromPartition(BROWSER_PARTITION));
    createWindow(APP_URL);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(APP_URL);
    });
    if (app.isPackaged) watchForUpdates();
  })
  .catch(() => app.quit());

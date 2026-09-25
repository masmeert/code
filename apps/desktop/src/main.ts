import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { registerBridge } from "./bridge.ts";
import { configureBrowserSession } from "./browser.ts";
import { APP_URL, registerRendererScheme, serveRenderer } from "./renderer.ts";
import { watchForUpdates } from "./updates.ts";
import { createWindow } from "./windows.ts";

const daemonToken = randomBytes(32).toString("hex");
let daemon: ChildProcess | null = null;
let daemonPort: Promise<number> | null = null;
let quitting = false;

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        // SAFETY: a TCP server listening on a host and port reports an AddressInfo, not a pipe path.
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
  });
}

// A fixed port let a daemon left over from an earlier launch (or a dev daemon) hold it,
// so ours failed to bind and the app waited on a daemon that rejects its token.
function startDaemon() {
  daemonPort = freePort().then((port) => {
    daemon = spawn(join(process.resourcesPath, "apcode-daemon"), {
      env: { ...process.env, APCODE_TOKEN: daemonToken, APCODE_PORT: String(port) },
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
});

app
  .whenReady()
  .then(() => {
    serveRenderer();
    configureBrowserSession();
    createWindow(APP_URL);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(APP_URL);
    });
    if (app.isPackaged) watchForUpdates();
  })
  .catch(() => app.quit());

import { AttachmentInput, BrowserAction, Theme } from "@masscode/contracts";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification } from "electron";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import { automateBrowser } from "./browserAutomation.ts";
import {
  addHost,
  ensureHostDaemon,
  listHosts,
  removeHost,
  restartHost,
  readSshAliases,
} from "./hosts.ts";
import { APP_URL } from "./renderer.ts";
import { checkForUpdates, downloadUpdate, installUpdate, getUpdateStatus } from "./updates.ts";

function registerIpcHandler<Argument extends Schema.ConstraintDecoder<unknown>, Result>(
  channel: string,
  schema: Argument,
  handleRequest: (window: BrowserWindow, argument: Argument["Type"]) => Result,
) {
  ipcMain.handle(channel, (event, argument) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !event.senderFrame?.url.startsWith(APP_URL))
      throw new Error(`${channel} is only available to MassCode windows`);

    return handleRequest(window, Schema.decodeUnknownSync(schema)(argument));
  });
}

/** The daemon tells images apart by media type, the agents read the rest from disk by name. */
const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** When each thread change was last announced; every open window reports the same change. */
const announced = new Map<string, number>();

/** Shown notifications, kept referenced so their click handler outlives garbage collection. */
const shown = new Set<Notification>();

export function registerBridge(findDaemon: () => Promise<{ port: number; token: string }> | null) {
  registerIpcHandler("daemon", Schema.Undefined, () => findDaemon());
  registerIpcHandler("hosts", Schema.Undefined, listHosts);
  registerIpcHandler("add-host", Schema.String, (_window, alias) => addHost(alias));
  registerIpcHandler("remove-host", Schema.String, (_window, alias) => removeHost(alias));
  registerIpcHandler("host-daemon", Schema.String, (_window, alias) => ensureHostDaemon(alias));
  registerIpcHandler("restart-host", Schema.String, (_window, alias) => restartHost(alias));
  registerIpcHandler("ssh-aliases", Schema.Undefined, readSshAliases);
  registerIpcHandler("read-files", Schema.Array(Schema.String), (_window, paths) =>
    Promise.all(
      paths.map(async (path) =>
        AttachmentInput.cases.data.make({
          name: basename(path),
          mediaType: MEDIA_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream",
          data: (await readFile(path)).toString("base64"),
        }),
      ),
    ),
  );
  registerIpcHandler(
    "pick-folder",
    Schema.Struct({ title: Schema.String, defaultPath: Schema.optional(Schema.String) }),
    async (window, { title, defaultPath }) =>
      (
        await dialog.showOpenDialog(window, {
          title,
          message: title,
          defaultPath: defaultPath?.replace(/^~(?=$|\/)/, homedir()) || homedir(),
          properties: ["openDirectory"],
        })
      ).filePaths[0] ?? null,
  );
  registerIpcHandler(
    "pick-files",
    Schema.String,
    async (window, title) =>
      (
        await dialog.showOpenDialog(window, {
          title,
          message: title,
          properties: ["openFile", "multiSelections"],
        })
      ).filePaths,
  );
  registerIpcHandler("set-theme", Theme, (_window, theme) => {
    nativeTheme.themeSource = theme;
  });
  registerIpcHandler(
    "automate-browser",
    Schema.Struct({ webContentsId: Schema.Number, action: BrowserAction }),
    (window, { webContentsId, action }) => automateBrowser(window, webContentsId, action),
  );
  registerIpcHandler("app-version", Schema.Undefined, () => app.getVersion());
  registerIpcHandler("update-status", Schema.Undefined, getUpdateStatus);
  registerIpcHandler("check-for-updates", Schema.Undefined, checkForUpdates);
  registerIpcHandler("download-update", Schema.Undefined, downloadUpdate);
  registerIpcHandler("install-update", Schema.Undefined, installUpdate);
  registerIpcHandler(
    "notify",
    Schema.Struct({ threadId: Schema.String, title: Schema.String, body: Schema.String }),
    (window, { threadId, title, body }) => {
      if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;

      const key = `${threadId}:${body}`;
      // ponytail: fixed 3s window to merge the windows' reports; per-event ids if it ever drops a real repeat
      if (Date.now() - (announced.get(key) ?? 0) < 3000) return;
      announced.set(key, Date.now());

      const notification = new Notification({ title, body });
      shown.add(notification);
      notification.on("close", () => shown.delete(notification));
      notification.on("click", () => {
        shown.delete(notification);
        if (window.isDestroyed()) return;

        window.show();
        window.focus();
        window.webContents.send("open-thread", threadId);
      });

      notification.show();
    },
  );
}

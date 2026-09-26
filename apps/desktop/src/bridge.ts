import { BrowserAction, Theme } from "@apcode/contracts";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification } from "electron";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import { automateBrowser } from "./browserAutomation.ts";
import { APP_URL } from "./renderer.ts";
import { checkForUpdates, installUpdate, updateStatus } from "./updates.ts";

function handle<S extends Schema.ConstraintDecoder<unknown>, Result>(
  channel: string,
  schema: S,
  listener: (window: BrowserWindow, arg: S["Type"]) => Result,
) {
  ipcMain.handle(channel, (event, arg) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !event.senderFrame?.url.startsWith(APP_URL))
      throw new Error(`${channel} is only available to APCode windows`);
    return listener(window, Schema.decodeUnknownSync(schema)(arg));
  });
}

/** When each thread change was last announced; every open window reports the same change. */
const announced = new Map<string, number>();
/** Shown notifications, kept referenced so their click handler outlives garbage collection. */
const shown = new Set<Notification>();

export function registerBridge(daemon: () => Promise<{ port: number; token: string }> | null) {
  handle("daemon", Schema.Undefined, () => daemon());
  handle(
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
  handle(
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
  handle("set-theme", Theme, (_window, theme) => {
    nativeTheme.themeSource = theme;
  });
  handle(
    "automate-browser",
    Schema.Struct({ webContentsId: Schema.Number, action: BrowserAction }),
    (window, { webContentsId, action }) => automateBrowser(window, webContentsId, action),
  );
  handle("app-version", Schema.Undefined, () => app.getVersion());
  handle("update-status", Schema.Undefined, updateStatus);
  handle("check-for-updates", Schema.Undefined, checkForUpdates);
  handle("install-update", Schema.Undefined, installUpdate);
  handle(
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
  handle("set-badge-count", Schema.Number, (_window, count) => {
    app.setBadgeCount(count);
  });
}

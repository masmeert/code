import { BrowserAction, Theme } from "@apcode/contracts";
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import * as Schema from "effect/Schema";
import { automateBrowser } from "./browserAutomation.ts";
import { APP_URL } from "./renderer.ts";

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

export function registerBridge(daemonToken: string | null) {
  handle("daemon-token", Schema.Undefined, () => daemonToken);
  handle(
    "pick-folder",
    Schema.String,
    async (window, title) =>
      (
        await dialog.showOpenDialog(window, {
          title,
          message: title,
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
}

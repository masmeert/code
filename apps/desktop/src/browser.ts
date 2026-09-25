import { BROWSER_PARTITION, DesktopBrowserEvent } from "@apcode/contracts";
import { type BrowserWindow, clipboard, Menu, session, shell, type WebContents } from "electron";
import { recordConsole } from "./browserAutomation.ts";

function isWebUrl(url: string) {
  return url.startsWith("https://") || url.startsWith("http://");
}

function sendToHost(window: BrowserWindow, event: DesktopBrowserEvent) {
  if (!window.isDestroyed()) window.webContents.send("browser-event", event);
}

function tabShortcut(
  input: Electron.Input,
): "new-tab" | "close-tab" | "focus-address" | "reload" | "back" | "forward" | null {
  if (
    input.type !== "keyDown" ||
    input.alt ||
    input.shift ||
    !(process.platform === "darwin" ? input.meta : input.control)
  )
    return null;
  switch (input.key.toLowerCase()) {
    case "t":
      return "new-tab";
    case "w":
      return "close-tab";
    case "l":
      return "focus-address";
    case "r":
      return "reload";
    case "[":
      return "back";
    case "]":
      return "forward";
    default:
      return null;
  }
}

function attachGuest(window: BrowserWindow, guest: WebContents) {
  recordConsole(guest);
  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (!isWebUrl(url)) return { action: "deny" };
    if (disposition === "new-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    sendToHost(
      window,
      DesktopBrowserEvent.cases["open-tab"].make({ webContentsId: guest.id, url }),
    );
    return { action: "deny" };
  });
  guest.on("did-create-window", (popup) =>
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" })),
  );
  guest.on("before-input-event", (event, input) => {
    const shortcut = tabShortcut(input);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "reload") guest.reload();
    else if (shortcut === "back") guest.navigationHistory.goBack();
    else if (shortcut === "forward") guest.navigationHistory.goForward();
    else sendToHost(window, DesktopBrowserEvent.cases[shortcut].make({ webContentsId: guest.id }));
  });
  guest.on("context-menu", (_event, params) => {
    guest.focus();
    Menu.buildFromTemplate([
      ...(isWebUrl(params.linkURL)
        ? [
            {
              label: "Open Link in New Tab",
              click: () =>
                sendToHost(
                  window,
                  DesktopBrowserEvent.cases["open-tab"].make({
                    webContentsId: guest.id,
                    url: params.linkURL,
                  }),
                ),
            },
            {
              label: "Open Link in Default Browser",
              click: () => shell.openExternal(params.linkURL).catch(() => {}),
            },
            { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
            { type: "separator" as const },
          ]
        : []),
      {
        label: "Back",
        enabled: guest.navigationHistory.canGoBack(),
        click: () => guest.navigationHistory.goBack(),
      },
      {
        label: "Forward",
        enabled: guest.navigationHistory.canGoForward(),
        click: () => guest.navigationHistory.goForward(),
      },
      { label: "Reload", click: () => guest.reload() },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll" },
      { type: "separator" },
      { label: "Inspect Element", click: () => guest.inspectElement(params.x, params.y) },
    ]).popup({ window });
  });
}

export function configureBrowserSession() {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
  browserSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowed.has(permission)),
  );
  browserSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

export function hostBrowser(window: BrowserWindow) {
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION || !isWebUrl(params.src ?? "")) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
  });
  window.webContents.on("did-attach-webview", (_event, guest) => attachGuest(window, guest));
}

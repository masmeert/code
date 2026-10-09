import { BROWSER_PARTITION, DesktopBrowserEvent } from "@masscode/contracts";
import {
  type BrowserWindow,
  clipboard,
  Menu,
  type Session,
  shell,
  type WebContents,
} from "electron";
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

  guest.on("context-menu", (_event, menu) => {
    guest.focus();
    Menu.buildFromTemplate([
      ...(isWebUrl(menu.linkURL)
        ? [
            {
              label: "Open Link in New Tab",
              click: () =>
                sendToHost(
                  window,
                  DesktopBrowserEvent.cases["open-tab"].make({
                    webContentsId: guest.id,
                    url: menu.linkURL,
                  }),
                ),
            },
            {
              label: "Open Link in Default Browser",
              click: () => shell.openExternal(menu.linkURL).catch(() => {}),
            },
            { label: "Copy Link", click: () => clipboard.writeText(menu.linkURL) },
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
      { role: "cut", enabled: menu.editFlags.canCut },
      { role: "copy", enabled: menu.editFlags.canCopy },
      { role: "paste", enabled: menu.editFlags.canPaste },
      { role: "selectAll" },
      { type: "separator" },
      { label: "Inspect Element", click: () => guest.inspectElement(menu.x, menu.y) },
    ]).popup({ window });
  });
}

export function configureBrowserSession(browserSession: Session) {
  const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);

  browserSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowed.has(permission)),
  );
  browserSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

export function hostBrowser(window: BrowserWindow) {
  window.webContents.on("will-attach-webview", (event, webPreferences, attributes) => {
    // Remote hosts' tabs have partitions of their own, named after this one.
    if (!attributes.partition?.startsWith(BROWSER_PARTITION) || !isWebUrl(attributes.src ?? "")) {
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

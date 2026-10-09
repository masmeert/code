import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, nativeTheme, type Rectangle, screen, shell } from "electron";
import { enableBrowserTabs } from "./browser.ts";
import { APP_URL } from "./renderer.ts";

const BOUNDS_PATH = join(app.getPath("userData"), "window-bounds.json");

function getBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? "#101010" : "#fcfcfc";
}

function isOnScreen(bounds: Rectangle) {
  return screen
    .getAllDisplays()
    .some(
      ({ workArea }) =>
        bounds.x < workArea.x + workArea.width &&
        bounds.x + bounds.width > workArea.x &&
        bounds.y < workArea.y + workArea.height &&
        bounds.y + bounds.height > workArea.y,
    );
}

function readSavedBounds(): Partial<Rectangle> {
  try {
    const bounds: Rectangle = JSON.parse(readFileSync(BOUNDS_PATH, "utf8"));
    return isOnScreen(bounds) ? bounds : { width: 1200, height: 800 };
  } catch {
    return { width: 1200, height: 800 };
  }
}

function openLink(url: string) {
  if (url.startsWith(APP_URL)) createWindow(url, { width: 1100, height: 760 });
  else if (url.startsWith("https://") || url.startsWith("http://"))
    shell.openExternal(url).catch(() => {});
}

nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows())
    window.setBackgroundColor(getBackgroundColor());
});

export function createWindow(url: string, bounds = readSavedBounds()) {
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: "MassCode",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 11 },
    backgroundColor: getBackgroundColor(),
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  enableBrowserTabs(window);
  window.once("ready-to-show", () => window.show());

  window.on("close", () => {
    try {
      writeFileSync(BOUNDS_PATH, JSON.stringify(window.getNormalBounds()));
    } catch {}
  });

  window.webContents.setWindowOpenHandler((details) => {
    openLink(details.url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(APP_URL)) return;

    event.preventDefault();
    openLink(target);
  });

  window.webContents.on(
    "did-fail-load",
    (_event, _errorCode, description, failedUrl, isMainFrame) => {
      if (isMainFrame && description === "ERR_CONNECTION_REFUSED")
        setTimeout(() => window.loadURL(failedUrl).catch(() => {}), 500);
    },
  );

  window.webContents.on("context-menu", (_event, menu) => {
    if (!menu.isEditable && !menu.selectionText) return;

    Menu.buildFromTemplate([
      ...menu.dictionarySuggestions.map((suggestion) => ({
        label: suggestion,
        click: () => window.webContents.replaceMisspelling(suggestion),
      })),
      { type: "separator" },
      { role: "cut", enabled: menu.editFlags.canCut },
      { role: "copy", enabled: menu.editFlags.canCopy },
      { role: "paste", enabled: menu.editFlags.canPaste },
      { role: "selectAll" },
    ]).popup({ window });
  });

  window.loadURL(url).catch(() => {});
}

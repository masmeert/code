import { LogicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauri } from "./platform.ts";

/** Opens another app window: a new chat in `path`, or the project picker when there's none. */
export const openWindow = (path: string | null) => {
  const url = path ? `/?path=${encodeURIComponent(path)}` : "/?home=1";
  if (!isTauri) {
    window.open(url, "_blank");
    return;
  }
  new WebviewWindow(`w-${Date.now()}`, {
    url,
    title: "APCode",
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "overlay",
    hiddenTitle: true,
    trafficLightPosition: new LogicalPosition(16, 20),
  });
};

import type { DesktopBridge } from "@masscode/contracts";

declare global {
  interface Window {
    readonly desktop?: DesktopBridge;
  }
}

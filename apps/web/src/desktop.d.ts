import type { DesktopBridge } from "@apcode/contracts";

declare global {
  interface Window {
    readonly desktop?: DesktopBridge;
  }
}

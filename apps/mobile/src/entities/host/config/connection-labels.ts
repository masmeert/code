import type { HostConnection } from "../model/host-store.ts";

/** How a computer's connection reads in a list. */
export const CONNECTION_STATUS: Record<HostConnection, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  offline: "Can't reach it",
  unpaired: "Unpaired",
  outdated: "Different version",
  off: "Off",
};

/** What's wrong and how to fix it, when the connection isn't working. */
export const CONNECTION_HELP: Partial<Record<HostConnection, string>> = {
  offline:
    "Check it's awake with MassCode open, phone access is on in its Settings → Phone, and both are online.",
  unpaired: "This computer unpaired the phone. Forget it, then pair again.",
  outdated: "This app and MassCode on that computer are different versions. Update the older one.",
};

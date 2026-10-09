import { UpdateStatus } from "@masscode/contracts";

/** What the update button says at each stage of an update, and what pressing it does. */
export function getUpdateAction(status: UpdateStatus) {
  return {
    label: UpdateStatus.match(status, {
      idle: () => "Check for updates",
      checking: () => "Checking…",
      "up-to-date": () => "Up to date",
      available: () => "Download update",
      downloading: ({ percent }) => `Downloading ${Math.round(percent)}%`,
      ready: () => "Restart to update",
      failed: () => "Try again",
    }),
    isBusy: UpdateStatus.isAnyOf(["checking", "downloading"])(status),
    run: () =>
      UpdateStatus.guards.ready(status)
        ? window.desktop?.installUpdate()
        : UpdateStatus.guards.available(status)
          ? window.desktop?.downloadUpdate()
          : window.desktop?.checkForUpdates(),
  };
}

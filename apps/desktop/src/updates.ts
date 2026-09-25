import { UpdateStatus } from "@apcode/contracts";
import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

let status: UpdateStatus = UpdateStatus.cases.idle.make({});

function setStatus(next: UpdateStatus) {
  status = next;
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("update-status-changed", status);
}

export function updateStatus() {
  return status;
}

export function checkForUpdates() {
  if (!app.isPackaged)
    return setStatus(
      UpdateStatus.cases.failed.make({ message: "Updates only work in the installed app." }),
    );
  // A downloaded update would be fetched again and flip the status back to downloading
  if (UpdateStatus.isAnyOf(["checking", "downloading", "ready"])(status)) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

export function installUpdate() {
  autoUpdater.quitAndInstall();
}

export function watchForUpdates() {
  autoUpdater.on("checking-for-update", () => setStatus(UpdateStatus.cases.checking.make({})));
  autoUpdater.on("update-not-available", () =>
    setStatus(UpdateStatus.cases["up-to-date"].make({})),
  );
  autoUpdater.on("update-available", ({ version }) =>
    setStatus(UpdateStatus.cases.downloading.make({ version, percent: 0 })),
  );
  autoUpdater.on("download-progress", ({ percent }) => {
    if (UpdateStatus.guards.downloading(status)) setStatus({ ...status, percent });
  });
  autoUpdater.on("update-downloaded", ({ version }) =>
    setStatus(UpdateStatus.cases.ready.make({ version })),
  );
  autoUpdater.on("error", (error) =>
    setStatus(
      UpdateStatus.cases.failed.make({
        message: `Couldn't update: ${error.message.split("\n")[0]}. Check your connection and try again.`,
      }),
    ),
  );
  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

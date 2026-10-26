import { isTurnActive, UpdateStatus } from "@masscode/contracts";
import { useEffect, useState } from "react";
import { getThreadHost, useThreadStore } from "@/entities/thread";

/** What the update button says at each stage of an update, and what pressing it does. */
function getUpdateAction(status: UpdateStatus) {
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

/**
 * `getUpdateAction`, but restarting while agents work on this Mac takes a second press: the
 * restart stops them. Threads on other machines keep running.
 */
export function useUpdateAction(status: UpdateStatus) {
  const [isConfirming, setIsConfirming] = useState(false);

  const workingCount = useThreadStore(
    (state) =>
      Object.values(state.threads).filter(
        (info) => isTurnActive(info.status) && getThreadHost(info.id) === null,
      ).length,
  );

  useEffect(() => {
    if (!isConfirming) return;

    const timer = setTimeout(() => setIsConfirming(false), 5000);

    return () => clearTimeout(timer);
  }, [isConfirming]);

  const action = getUpdateAction(status);
  const shouldConfirm = UpdateStatus.guards.ready(status) && workingCount > 0;
  const agents = workingCount === 1 ? "agent" : "agents";

  return {
    ...action,
    label:
      shouldConfirm && isConfirming
        ? `Restart and stop ${workingCount} working ${agents}?`
        : action.label,
    /** Why restarting now costs something; null when it doesn't. */
    warning: shouldConfirm
      ? `${workingCount} ${agents} working on this Mac will stop when MassCode restarts.`
      : null,
    isConfirming: shouldConfirm && isConfirming,
    run: () => (shouldConfirm && !isConfirming ? setIsConfirming(true) : action.run()),
  };
}

import { isTurnActive, type ThreadStatus } from "@masscode/contracts";
import { getHostState } from "@/entities/host";
import { formatHarnessLabel } from "@/entities/provider";
import { getSettings } from "@/entities/settings";
import { watchThreads } from "@/entities/thread";

function describeChange(was: ThreadStatus, status: ThreadStatus) {
  if (status === "awaiting-approval") return "needs your approval";

  if (status === "awaiting-answer") return "has a question for you";

  if (status === "error") return "stopped with an error";

  if (status === "idle" && isTurnActive(was)) return "finished";

  return null;
}

/**
 * Tells you, through the OS, when a thread finishes, stops on an error or waits on an
 * approval. The desktop shell drops notifications while an MassCode window is focused and
 * merges every window's report of the same change.
 */
watchThreads((prev, next) => {
  const desktop = window.desktop;

  if (!desktop || next.threads === prev.threads) return;

  // Only live changes: loading the cache or reconnecting isn't news. A shell updates the thread
  // list before its host, so the source here is still the one from before it.
  if (getHostState().source !== "daemon" || getSettings().notifications === false) return;

  for (const id of next.order) {
    const info = next.threads[id];
    const was = prev.threads[id]?.status;

    if (was === undefined || was === info.status) continue;

    const body = describeChange(was, info.status);

    if (body)
      void desktop.notify({
        threadId: id,
        title: info.title,
        body: `${formatHarnessLabel(getSettings(), info.provider)} ${body}`,
      });
  }
});

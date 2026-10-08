import { isTurnActive } from "@masscode/contracts";
import { harnessLabel } from "./models.ts";
import { watchState } from "./store.ts";

/**
 * Tells you, through the OS, when a thread finishes, stops on an error or waits on an
 * approval. The desktop shell drops notifications while an MassCode window is focused and
 * merges every window's report of the same change.
 */
watchState((prev, next) => {
  const desktop = window.desktop;
  if (!desktop || next.threads === prev.threads) return;
  // Only live changes: loading the cache or reconnecting isn't news.
  if (prev.source === "daemon" && next.settings.notifications !== false)
    for (const id of next.order) {
      const info = next.threads[id]!;
      const was = prev.threads[id]?.status;
      if (was === undefined || was === info.status) continue;
      const body =
        info.status === "awaiting-approval"
          ? "needs your approval"
          : info.status === "awaiting-answer"
            ? "has a question for you"
            : info.status === "error"
              ? "stopped with an error"
              : info.status === "idle" && isTurnActive(was)
                ? "finished"
                : null;
      if (body)
        void desktop.notify({
          threadId: id,
          title: info.title,
          body: `${harnessLabel(next.settings, info.provider)} ${body}`,
        });
    }
});

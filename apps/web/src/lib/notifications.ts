import { harnessLabel } from "./models.ts";
import { isSeen, watchState } from "./store.ts";

/**
 * Tells you, through the OS, when a thread finishes, stops on an error or waits on an
 * approval, and keeps the dock badge at the number of threads needing you. The desktop
 * shell drops notifications while an APCode window is focused and merges every window's
 * report of the same change.
 */
let badge = 0;
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
          : info.status === "error"
            ? "stopped with an error"
            : info.status === "idle" && (was === "running" || was === "awaiting-approval")
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

watchState((prev, next) => {
  if (!window.desktop || (next.threads === prev.threads && next.seen === prev.seen)) return;
  const needingYou = next.order.filter((id) => {
    const info = next.threads[id]!;
    return (
      info.archivedAt === null &&
      (info.status === "awaiting-approval" ||
        (info.status !== "running" && !isSeen(info, next.seen)))
    );
  }).length;
  if (needingYou === badge) return;
  badge = needingYou;
  void window.desktop.setBadgeCount(needingYou);
});

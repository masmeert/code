import type { ThreadInfo } from "@masscode/contracts";

/** Why a thread needs you, as its dot and its trailing label say it. */
export const NEEDS_YOU: Partial<
  Record<ThreadInfo["status"], { label: string; dotTone: string; labelTone: string }>
> = {
  "awaiting-approval": {
    label: "Needs approval",
    dotTone: "bg-warning",
    labelTone: "text-warning",
  },
  "awaiting-answer": { label: "Needs an answer", dotTone: "bg-warning", labelTone: "text-warning" },
  error: { label: "Error", dotTone: "bg-destructive", labelTone: "text-destructive" },
};

/** The thread's dot: hue only when it needs you, solid while there's something new. */
export function getStatusDotStyle(info: ThreadInfo, isUnread: boolean, isShelved: boolean) {
  const needsYou = NEEDS_YOU[info.status];

  if (needsYou) return { label: needsYou.label, tone: needsYou.dotTone };

  if (info.status === "running") return { label: "Working", tone: "bg-success animate-pulse" };

  if (isUnread) return { label: "New activity", tone: "bg-brand" };

  if (isShelved) return { label: "Shelved", tone: "bg-muted-foreground/25" };

  return { label: "Idle", tone: "bg-brand" };
}

/** A finished thought's label: "Thought for 12s", or "Thought" when its length is unknown. */
export function describeThought(durationMs: number | undefined) {
  if (durationMs === undefined) return "Thought";

  const seconds = Math.max(1, Math.round(durationMs / 1000));

  return seconds < 60
    ? `Thought for ${seconds}s`
    : `Thought for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

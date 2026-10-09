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

const THOUGHT_TITLES = [
  "Schlepped",
  "Combobulated",
  "Channelled",
  "Vibed",
  "Concocted",
  "Spelunked",
];

/** A finished thought's title, the same every time for the same `id`. */
export function thoughtTitle(id: string) {
  return THOUGHT_TITLES[
    [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0) % THOUGHT_TITLES.length
  ]!;
}

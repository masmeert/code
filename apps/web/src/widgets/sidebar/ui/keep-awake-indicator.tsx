import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import { Coffee, X } from "lucide-react";
import { stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { IconButton } from "@/shared/ui";

/** Shown while this Mac is kept awake, so it's never kept awake unnoticed. */
export function KeepAwakeIndicator() {
  const session = useKeepAwake()?.session;
  const now = useNow(15_000);

  if (!session) return null;

  return (
    <div className="flex h-8 items-center gap-2 rounded-lg bg-muted/50 pr-0.5 pl-2 text-sm">
      <Coffee className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {session.reason === "manual" ? "Kept awake" : "Awake for agents"}
      </span>
      <span
        title={`Until ${formatClockTime(session.endsAt)} at the latest`}
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {formatTimeLeft(session.endsAt - now)}
      </span>
      <IconButton label="Stop keeping this Mac awake" onClick={stopKeepAwake} className="size-6">
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import { Coffee } from "lucide-react";
import { stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { IconButton } from "@/shared/ui";

/** Shown while this Mac is kept awake, so it's never kept awake unnoticed. */
export function KeepAwakeIndicator() {
  const session = useKeepAwake()?.session;
  const now = useNow(15_000);

  if (!session) return null;

  const manual = session.reason === "manual";

  return (
    <IconButton
      label={`${manual ? "Kept awake" : "Awake for agents"} until ${formatClockTime(session.endsAt)} at the latest. Click to stop keeping this Mac awake.`}
      onClick={stopKeepAwake}
      className="w-auto grid-flow-col gap-1 px-1.5 text-foreground"
    >
      <Coffee className="size-4" />
      {/* An agents session ends when the agents do; its endsAt is only the safety cap, not a countdown. */}
      {manual && (
        <span className="text-xs tabular-nums">{formatTimeLeft(session.endsAt - now)}</span>
      )}
    </IconButton>
  );
}

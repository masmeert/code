import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import { IconCoffee } from "@tabler/icons-react";
import { stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { IconButton } from "@/shared/ui";

/** Shown while this Mac is kept awake, so it's never kept awake unnoticed. */
export function KeepAwakeIndicator() {
  const session = useKeepAwake()?.session;
  const now = useNow(15_000);

  if (!session) return null;

  const manual = session.reason === "manual";

  // An agents session ends when the agents do; its endsAt is only the safety cap, not a countdown.
  const status = manual
    ? `Kept awake for ${formatTimeLeft(session.endsAt - now)}, until ${formatClockTime(session.endsAt)}.`
    : `Awake for agents until ${formatClockTime(session.endsAt)} at the latest.`;

  return (
    <IconButton
      label={`${status} Click to stop keeping this Mac awake.`}
      onClick={stopKeepAwake}
      className="text-foreground"
    >
      <IconCoffee className="size-4" />
    </IconButton>
  );
}

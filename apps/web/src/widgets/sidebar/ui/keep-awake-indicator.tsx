import { formatClockTime, formatTimeLeft, useNow } from "@masscode/client";
import { IconCoffee, IconCoffeeOff, IconSettings } from "@tabler/icons-react";
import {
  MorphingPopover,
  MorphingPopoverContent,
  MorphingPopoverMenu,
  MorphingPopoverTrigger,
} from "@masmeert/ui/morphing-popover";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { useState } from "react";
import { stopKeepAwake, useKeepAwake } from "@/entities/keep-awake";
import { IconButton } from "@/shared/ui";
import { cn } from "@masscode/ui/lib/utils";

const rowClass = cn(
  typeClass("caption"),
  "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-foreground outline-none focus-visible:ring-4 focus-visible:ring-ring",
);

/** Shown while this Mac is kept awake, so it's never kept awake unnoticed. Opens what it's doing and a way out. */
export function KeepAwakeIndicator({ onOpenSettings }: { onOpenSettings: () => void }) {
  const session = useKeepAwake()?.session;
  const now = useNow(15_000);
  const [isOpen, setIsOpen] = useState(false);

  if (!session) return null;

  const manual = session.reason === "manual";

  // An agents session ends when the agents do; its endsAt is only the safety cap, not a countdown.
  const title = manual ? "Kept awake" : "Awake for agents";

  const detail = manual
    ? `${formatTimeLeft(session.endsAt - now)} left, until ${formatClockTime(session.endsAt)}`
    : `Until they finish, ${formatClockTime(session.endsAt)} at the latest`;

  return (
    <MorphingPopover open={isOpen} onOpenChange={setIsOpen}>
      <MorphingPopoverTrigger>
        <IconButton label={`${title}. ${detail}.`} className="text-foreground">
          <IconCoffee className="size-4" />
        </IconButton>
      </MorphingPopoverTrigger>
      <MorphingPopoverContent side="top" align="start" sideOffset={8} radius={12} className="w-60">
        <div className="px-3 pt-2.5 pb-1.5">
          <p className={cn(typeClass("body"), "font-medium text-foreground")}>{title}</p>
          <p className={cn(typeClass("caption"), "text-muted-foreground")}>{detail}</p>
        </div>
        <MorphingPopoverMenu className="p-1.5 pt-0">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              stopKeepAwake();
            }}
            className={rowClass}
          >
            <IconCoffeeOff aria-hidden="true" className="size-3.5 shrink-0" />
            Stop keeping awake
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onOpenSettings();
            }}
            className={rowClass}
          >
            <IconSettings aria-hidden="true" className="size-3.5 shrink-0" />
            Keep awake settings…
          </button>
        </MorphingPopoverMenu>
      </MorphingPopoverContent>
    </MorphingPopover>
  );
}

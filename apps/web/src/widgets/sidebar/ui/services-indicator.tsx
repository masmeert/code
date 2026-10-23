import { Button } from "@masmeert/ui/button";
import { EthernetPort } from "lucide-react";
import { useServices } from "@/entities/service";

/** Shown while threads left something listening, so a forgotten dev server is a click from stopped. */
export function ServicesIndicator({ onOpen }: { onOpen: () => void }) {
  const count = useServices().length;

  if (count === 0) return null;

  return (
    <Button
      variant="ghost"
      onClick={onOpen}
      className="h-8 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-muted-foreground hover:text-foreground"
    >
      <EthernetPort className="size-4" />
      Services
      <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[11px] leading-4 tabular-nums">
        {count}
      </span>
    </Button>
  );
}

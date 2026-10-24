import { IconNetwork } from "@tabler/icons-react";
import { useServices } from "@/entities/service";
import { IconButton } from "@/shared/ui";
import { typeClass } from "@masmeert/ui/lib/type-scale";
import { cn } from "@masscode/ui/lib/utils";

/** Shown while threads left something listening, so a forgotten dev server is a click from stopped. */
export function ServicesIndicator({ onOpen }: { onOpen: () => void }) {
  const count = useServices().length;

  if (count === 0) return null;

  return (
    <IconButton
      label={`${count} running ${count === 1 ? "service" : "services"}`}
      onClick={onOpen}
      className="w-auto grid-flow-col gap-1 px-1.5"
    >
      <IconNetwork className="size-4" />
      <span className={cn(typeClass("caption"), "tabular-nums")}>{count}</span>
    </IconButton>
  );
}

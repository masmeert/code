import { IconBroadcast } from "@tabler/icons-react";
import { useServices } from "@/entities/service";
import { IconButton } from "@/shared/ui";

/** Shown while threads left something listening, so a forgotten dev server is a click from stopped. */
export function ServicesIndicator({ onOpen }: { onOpen: () => void }) {
  const count = useServices().length;

  if (count === 0) return null;

  return (
    <IconButton label={`${count} running ${count === 1 ? "service" : "services"}`} onClick={onOpen}>
      <IconBroadcast className="size-4" />
    </IconButton>
  );
}

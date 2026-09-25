import { cn } from "@apcode/ui/lib/utils";
import type { ReactNode } from "react";

export function IconButton({
  label,
  onClick,
  active,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        active && "bg-muted/60 text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

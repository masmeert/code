import { cn } from "@masscode/ui/lib/utils";
import type { ComponentProps, ReactNode } from "react";

/** Rest props and the ref reach the button, so a popover trigger can wrap it. */
export function IconButton({
  label,
  shortcut,
  onClick,
  isActive,
  disabled,
  className,
  children,
  ...rest
}: Omit<ComponentProps<"button">, "onClick" | "children"> & {
  label: string;
  /** How its keyboard shortcut reads, e.g. ⌘,; shown in the tooltip. */
  shortcut?: string;
  onClick?: () => void;
  isActive?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={isActive}
      disabled={disabled}
      onClick={onClick}
      {...rest}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        "aria-expanded:bg-hover aria-expanded:text-foreground",
        isActive && "bg-selected text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

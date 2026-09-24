import { cn } from "@/lib/utils";

/**
 * A thin vertical drag handle laid over an element's edge. Wider hit area than it looks;
 * the line lights up on hover and while dragging.
 */
export const ResizeHandle = ({
  side,
  dragging,
  label,
  value,
  className,
  ...handlers
}: {
  side: "start" | "end";
  dragging: boolean;
  label: string;
  value: number;
  className?: string;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onDoubleClick: React.MouseEventHandler<HTMLElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLElement>;
}) => (
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    aria-valuenow={value}
    tabIndex={0}
    title="Drag to resize, double-click to reset"
    {...handlers}
    className={cn(
      "group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none",
      side === "start" ? "-left-1" : "-right-1",
      className,
    )}
  >
    <span
      className={cn(
        "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150",
        dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring/70 group-focus-visible:bg-ring",
      )}
    />
  </div>
);

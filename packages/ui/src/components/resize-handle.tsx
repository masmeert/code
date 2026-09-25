import { cn } from "@apcode/ui/lib/utils";

/**
 * A thin drag handle laid over an element's edge. Wider hit area than it looks;
 * the line lights up on hover and while dragging.
 */
export const ResizeHandle = ({
  side,
  axis = "x",
  dragging,
  label,
  value,
  className,
  ...handlers
}: {
  side: "start" | "end";
  axis?: "x" | "y";
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
    aria-orientation={axis === "x" ? "vertical" : "horizontal"}
    aria-label={label}
    aria-valuenow={value}
    tabIndex={0}
    title="Drag to resize, double-click to reset"
    {...handlers}
    className={cn(
      "group absolute z-20 touch-none outline-none",
      axis === "x" ? "inset-y-0 w-2 cursor-col-resize" : "inset-x-0 h-2 cursor-row-resize",
      axis === "x"
        ? side === "start"
          ? "-left-1"
          : "-right-1"
        : side === "start"
          ? "-top-1"
          : "-bottom-1",
      className,
    )}
  >
    <span
      className={cn(
        "absolute transition-colors duration-150",
        axis === "x"
          ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
          : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        dragging ? "bg-ring" : "bg-transparent group-hover:bg-ring/70 group-focus-visible:bg-ring",
      )}
    />
  </div>
);

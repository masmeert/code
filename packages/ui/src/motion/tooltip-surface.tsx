import { motion, useReducedMotion } from "motion/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { EASE_OUT } from "@apcode/ui/lib/ease";
import { cn } from "@apcode/ui/lib/utils";

/** The shared visual surface for trigger tooltips and chart readouts. Positioning belongs to the caller. */
export function TooltipSurface({
  children,
  className,
  ref,
  ...props
}: Omit<ComponentProps<typeof motion.span>, "children"> & {
  children?: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      ref={ref}
      role="tooltip"
      variants={
        reduce
          ? {
              initial: { opacity: 0 },
              animate: { opacity: 1, transition: { duration: 0.14, ease: EASE_OUT } },
              exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } },
            }
          : {
              initial: { opacity: 0, transform: "scale(0.97)" },
              animate: {
                opacity: 1,
                transform: "scale(1)",
                transition: { duration: 0.15, ease: EASE_OUT },
              },
              exit: {
                opacity: 0,
                transform: "scale(0.97)",
                transition: { duration: 0.12, ease: EASE_OUT },
              },
            }
      }
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        "block rounded-lg border border-border bg-popover px-2.5 py-1 text-xs font-medium whitespace-nowrap text-foreground shadow-panel",
        className,
      )}
      {...props}
    >
      {children}
    </motion.span>
  );
}

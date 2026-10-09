import { motion, type HTMLMotionProps, useReducedMotion } from "motion/react";
import { type CSSProperties, useState } from "react";
import { EASE_OUT } from "@masscode/ui/lib/ease";
import { cn } from "@masscode/ui/lib/utils";

export interface AgentDisclosureProps extends Omit<HTMLMotionProps<"div">, "animate" | "initial"> {
  open: boolean;
  openHeight?: CSSProperties["height"];
}

/** Shared transform-only reveal for collapsible agent content. */
export function AgentDisclosure({
  open,
  openHeight = "auto",
  className,
  style,
  transition,
  children,
  ...props
}: AgentDisclosureProps) {
  const reduce = useReducedMotion() ?? false;
  // Collapsed content (tool output, diffs) can be thousands of nodes a turn: it isn't built
  // until first opened, then stays for the closing animation.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);

  return (
    <motion.div
      {...props}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        reduce
          ? { opacity: open ? 1 : 0 }
          : {
              opacity: open ? 1 : 0,
              clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
              transform: open ? "translateY(0px)" : "translateY(-4px)",
            }
      }
      transition={
        transition ?? {
          duration: open && !reduce ? 0.22 : 0,
          ease: EASE_OUT,
        }
      }
      className={cn("overflow-hidden", className)}
      style={{
        ...style,
        height: open ? openHeight : 0,
        pointerEvents: open ? undefined : "none",
        transformOrigin: "top",
      }}
    >
      {opened ? children : null}
    </motion.div>
  );
}

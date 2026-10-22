import { motion, type TargetAndTransition, useInView, useReducedMotion } from "motion/react";
import { type ReactNode, type RefObject, useRef } from "react";

import { EASE_OUT } from "@masscode/ui/lib/ease";
import { cn } from "@masscode/ui/lib/utils";

export interface ScrollRevealProps {
  children: ReactNode;
  /** Slide distance in px before reveal. */
  y?: number;
  /** Enter blur in px (kept ≤ 10 per motion conventions). */
  blur?: number;
  durationSeconds?: number;
  delaySeconds?: number;
  /** Reveal only once (default) or every time it enters view. */
  once?: boolean;
  /** Portion of the element that must be visible to trigger. */
  amount?: "some" | "all" | number;
  /** Scroll root for contained scroll areas. Defaults to the viewport. */
  root?: RefObject<Element | null>;
  className?: string;
}

export function ScrollReveal({
  children,
  y = 16,
  blur = 8,
  durationSeconds = 0.6,
  delaySeconds = 0,
  once = true,
  amount = 0.3,
  root,
  className,
}: ScrollRevealProps) {
  const prefersReducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { root, once, amount });

  const hidden: TargetAndTransition = { opacity: 0 };
  const shown: TargetAndTransition = { opacity: 1 };
  if (!prefersReducedMotion) {
    hidden.y = y;
    shown.y = 0;
    if (blur > 0) {
      hidden.filter = `blur(${blur}px)`;
      shown.filter = "blur(0px)";
    }
  }

  return (
    <motion.div
      ref={ref}
      initial={hidden}
      animate={inView ? shown : hidden}
      transition={{ duration: durationSeconds, ease: EASE_OUT, delay: delaySeconds }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  );
}

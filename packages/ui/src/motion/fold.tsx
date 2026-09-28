import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { FOLD } from "@apcode/ui/lib/ease";

/** Folds its content open and shut; clipped only while moving, so focus rings aren't cut once open. */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={reduce ? false : { height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: 0 } }
              : { height: 0, opacity: 0, overflow: "hidden" }
          }
          transition={FOLD}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

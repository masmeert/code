import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT, SPRING_PANEL } from "@masscode/ui/lib/ease";
import { PresenceGate } from "@masscode/ui/motion/presence-gate";
import { cn } from "@masscode/ui/lib/utils";

export interface MorphingModalProps {
  /** Which view is currently shown. `null` closes the modal. Escape and the backdrop call `onClose`. */
  viewId: string | null;
  onClose: () => void;
  children: ReactNode;
  /** "bottom" anchors to the viewport bottom (mobile-like). "center" centers vertically. */
  placement?: "bottom" | "center";
  className?: string;
}

export function MorphingModal({
  viewId,
  onClose,
  children,
  placement = "bottom",
  className,
}: MorphingModalProps) {
  const open = viewId !== null;
  const reduce = useReducedMotion();
  const enterY = reduce ? 0 : placement === "bottom" ? 40 : 20;
  const enterScale = reduce ? 1 : 0.97;

  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    // Focus left behind the modal keeps getting keys, and a terminal there swallows Escape.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const takeFocus = !panel.current?.contains(previous);
    if (takeFocus) panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (takeFocus) previous?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Mounted only while open, and while open the chrome is two fixed siblings
  // rather than one wrapper: the backdrop spans the viewport edges but carries
  // the scrim colour, and the layer positioning the panel sits inset off every
  // edge (`inset-4`, with the bottom placement's `pb-4` on top of it). Both hang
  // off `PresenceGate`, so interaction releases in the same commit that starts
  // the exit rather than when it ends — `open` is already false for those
  // frames. See tests/fixed-overlay-edge-sampling.test.tsx.
  // Portaled so a caller inside a stacking context (the transcript) still paints above the composer.
  return createPortal(
    <AnimatePresence initial={false}>
      {open ? (
        <PresenceGate key="backdrop">
          {({ gate }) => (
            <motion.button
              type="button"
              aria-label="Close modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              {...gate}
              onClick={onClose}
              // Electron hit-tests `app-region: drag` regardless of stacking, so a drag
              // region under the modal would swallow its clicks and scrolling.
              className="pointer-events-auto fixed inset-0 z-[80] bg-black/30 [backdrop-filter:blur(24px)_saturate(140%)] [-webkit-app-region:no-drag] [-webkit-backdrop-filter:blur(24px)_saturate(140%)]"
            />
          )}
        </PresenceGate>
      ) : null}

      {open ? (
        <PresenceGate key="panel-layer">
          {({ isPresent, gate }) => (
            // The layer itself never takes pointer events, so it carries
            // `inert` alone rather than the gate's pointer-events value.
            <div
              inert={!isPresent}
              className={cn(
                "pointer-events-none fixed inset-4 z-[80] flex justify-center",
                placement === "bottom" ? "items-end pb-4" : "items-center",
              )}
            >
              <motion.div
                key="panel"
                ref={panel}
                tabIndex={-1}
                layout={!reduce}
                initial={{ opacity: 0, y: enterY, scale: enterScale }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{
                  opacity: 0,
                  y: enterY,
                  scale: reduce ? 1 : 0.98,
                  transition: { duration: 0.18, ease: EASE_OUT },
                }}
                transition={SPRING_PANEL}
                {...gate}
                className={cn(
                  "pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-panel will-change-transform outline-none",
                  className,
                )}
              >
                <motion.div layout={reduce ? false : "position"} className="p-5">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={viewId}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
                      animate={
                        reduce
                          ? {
                              opacity: 1,
                              transition: {
                                duration: 0.18,
                                ease: EASE_OUT,
                              },
                            }
                          : {
                              opacity: 1,
                              y: 0,
                              filter: "blur(0px)",
                              transition: {
                                duration: 0.24,
                                ease: EASE_OUT,
                              },
                            }
                      }
                      exit={
                        reduce
                          ? {
                              opacity: 0,
                              transition: {
                                duration: 0.14,
                                ease: EASE_OUT,
                              },
                            }
                          : {
                              opacity: 0,
                              y: -8,
                              filter: "blur(4px)",
                              transition: {
                                duration: 0.16,
                                ease: EASE_OUT,
                              },
                            }
                      }
                    >
                      {children}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </div>
          )}
        </PresenceGate>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

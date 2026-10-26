import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { spring, springExit, tierTween } from "@masmeert/ui/lib/springs";
import { PresenceGate } from "@masmeert/ui/presence-gate";
import { cn } from "@masscode/ui/lib/utils";

export interface MorphingModalProps {
  /** Which view is currently shown. `null` closes the modal. Escape and the backdrop call `onClose`. */
  viewId: string | null;
  onClose: () => void;
  children: ReactNode;
  /** "bottom" anchors to the viewport bottom (mobile-like). "center" centers vertically. */
  placement?: "bottom" | "center";
  className?: string;
  /** Names the dialog for assistive tech; prefer `ariaLabelledBy` when a visible title exists. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

/** Open panels, oldest first: with focus lost to the page, Escape closes only the topmost. */
const openPanels: Array<HTMLElement> = [];

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Keeps Tab and Shift+Tab cycling through the panel's own controls. */
function trapTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;

  const tabbables = [...event.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.getClientRects().length > 0 && !element.closest("[inert]"),
  );

  const first = tabbables[0];
  const last = tabbables.at(-1);

  if (!first || !last) {
    event.preventDefault();

    return;
  }

  const active = document.activeElement;

  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function MorphingModal({
  viewId,
  onClose,
  children,
  placement = "bottom",
  className,
  ariaLabel,
  ariaLabelledBy,
}: MorphingModalProps) {
  const open = viewId !== null;
  const reduce = useReducedMotion();
  const enterY = reduce ? 0 : placement === "bottom" ? 40 : 20;
  const enterScale = reduce ? 1 : 0.97;

  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    // Focus left behind the modal keeps getting keys, and a terminal there swallows Escape.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const takeFocus = !element.contains(previous);
    if (takeFocus) element.focus({ preventScroll: true });
    openPanels.push(element);
    // Bubbling, so a menu or field inside that handles Escape (and says so) gets it first. Escape
    // from outside the panel belongs to whatever has focus there: a portaled popover, another modal.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const isFocusLost = event.target === document.body || event.target === document;
      if (
        !(event.target instanceof Node && element.contains(event.target)) &&
        !(isFocusLost && openPanels.at(-1) === element)
      )
        return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      openPanels.splice(openPanels.indexOf(element), 1);
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
              tabIndex={-1}
              aria-label="Close modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={spring.fast}
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
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy}
                tabIndex={-1}
                onKeyDown={trapTab}
                layout={!reduce}
                initial={{ opacity: 0, y: enterY, scale: enterScale }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{
                  opacity: 0,
                  y: enterY,
                  scale: reduce ? 1 : 0.98,
                  transition: springExit.slow,
                }}
                transition={spring.slow}
                {...gate}
                className={cn(
                  "pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-surface-3 will-change-transform outline-none",
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
                              transition: spring.fast,
                            }
                          : {
                              opacity: 1,
                              y: 0,
                              filter: "blur(0px)",
                              transition: tierTween.slow,
                            }
                      }
                      exit={
                        reduce
                          ? {
                              opacity: 0,
                              transition: springExit.fast,
                            }
                          : {
                              opacity: 0,
                              y: -8,
                              filter: "blur(4px)",
                              transition: springExit.moderate,
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

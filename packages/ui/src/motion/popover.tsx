import {
  animate,
  type MotionValue,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
} from "motion/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverPortalPosition } from "@masscode/ui/lib/popover-position";
import { useDismiss } from "@masscode/ui/hooks/use-dismiss";
import { type HoverGesture, useHoverGesture } from "@masscode/ui/hooks/use-hover-gesture";
import { useTapGesture } from "@masscode/ui/hooks/use-tap-gesture";
import {
  buildGeometry,
  clipPathAtProgress,
  triggerCutoutPath,
  type Align,
  type Geometry,
  type Side,
} from "@masscode/ui/lib/popover-geometry";
import { cn } from "@masscode/ui/lib/utils";

type TriggerMode = "click" | "hover";

// This morph needs less bounce than layout motion: too much overshoot makes
// the liquid neck balloon past the final panel edges.
const GOO_OPEN_SPRING = {
  type: "spring",
  visualDuration: 0.3,
  bounce: 0.15,
} as const;
const GOO_CLOSE_SPRING = {
  type: "spring",
  visualDuration: 0.21,
  bounce: 0.15,
} as const;
const HOVER_CLOSE_DELAY_MS = 120;

// `onPointerEnter`/`onPointerLeave` rather than the mouse pair: a tap fires
// compatibility mouseenter/mouseleave that carry no pointerType at all, and
// they are what made the panel flicker open and shut under a finger. The
// gesture pairs the two, so the panel a pen tap opened is not closed again by
// the boundary event that ends the same tap.
function makeHoverHandlers(hover: HoverGesture, enter: () => void, leave: () => void) {
  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (hover.enter(event)) enter();
    },
    onPointerLeave: (event: React.PointerEvent) => {
      if (hover.leave(event)) leave();
    },
  };
}

interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  openHover: () => void;
  scheduleClose: () => void;
  triggerMode: TriggerMode;
  side: Side;
  align: Align;
  gap: number;
  panelRadius: number;
  gooStrength: number;
  prefersReducedMotion: boolean;
  gooId: string;
  contentId: string;
  progress: MotionValue<number>;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentRef: React.MutableRefObject<HTMLDivElement | null>;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string) {
  const context = use(PopoverContext);
  if (!context) throw new Error(`${component} must be used within <Popover>`);
  return context;
}

export interface PopoverProps {
  children: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** How the popover is summoned. Default "click". */
  trigger?: TriggerMode;
  /** Which side of the trigger the panel oozes out of. Default "bottom". */
  side?: Side;
  /** Alignment along the trigger's edge. Default "center". */
  align?: Align;
  /** Gap between trigger and panel, in px — the length of the gooey neck. Default 14. */
  sideOffset?: number;
  /** Corner radius of the open panel, in px. Default 16. */
  panelRadius?: number;
  /** Blur radius feeding the goo filter — higher melts more. Default 8. */
  gooStrength?: number;
  className?: string;
}

export function Popover({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  trigger = "click",
  side = "bottom",
  align = "center",
  sideOffset = 14,
  panelRadius = 16,
  gooStrength = 8,
  className,
}: PopoverProps) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const gooId = useId().replace(/:/g, "");
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootHover = useHoverGesture();
  const progress = useMotionValue(defaultOpen ? 1 : 0);

  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openHover = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose, setOpen]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelClose, setOpen]);

  const toggle = useCallback(() => setOpen(!open), [setOpen, open]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    const animation = animate(
      progress,
      open ? 1 : 0,
      prefersReducedMotion ? { duration: 0 } : open ? GOO_OPEN_SPRING : GOO_CLOSE_SPRING,
    );
    return () => animation.stop();
  }, [open, progress, prefersReducedMotion]);

  // The panel is a `role="dialog"` and goes inert the moment it closes, so
  // focus cannot be left sitting inside it: Escape hands it back to the
  // trigger, the way the ARIA dialog pattern asks. A pointer dismissal takes
  // the focus onward itself when it lands on something focusable — this only
  // catches the case where it would otherwise be stranded.
  const close = useCallback(() => {
    setOpen(false);
    const focused = document.activeElement;
    const inPanel = focused instanceof HTMLElement && contentRef.current?.contains(focused);
    if (inPanel) triggerRef.current?.focus();
  }, [setOpen]);
  // The panel is portalled, so both trees participate in outside detection.
  const ignoreContent = useCallback(
    (target: Element) => Boolean(contentRef.current?.contains(target)),
    [],
  );
  // A hover trigger opens on tap as well now, so it needs the same outside
  // dismissal the click trigger always had. The gesture passes through to
  // whatever it landed on, which is the light-dismiss bargain the platform's
  // own popovers strike.
  useDismiss(open, close, rootRef, { ignore: ignoreContent });

  const context = useMemo<PopoverContextValue>(
    () => ({
      open,
      setOpen,
      toggle,
      openHover,
      scheduleClose,
      triggerMode: trigger,
      side,
      align,
      gap: sideOffset,
      panelRadius,
      gooStrength,
      prefersReducedMotion,
      gooId,
      contentId,
      progress,
      triggerRef,
      contentRef,
    }),
    [
      open,
      setOpen,
      toggle,
      openHover,
      scheduleClose,
      trigger,
      side,
      align,
      sideOffset,
      panelRadius,
      gooStrength,
      prefersReducedMotion,
      gooId,
      contentId,
      progress,
    ],
  );

  const hoverHandlers =
    trigger === "hover" ? makeHoverHandlers(rootHover, openHover, scheduleClose) : {};

  return (
    <PopoverContext value={context}>
      <div
        ref={rootRef}
        className={cn("relative isolate inline-flex", className)}
        {...hoverHandlers}
      >
        {children}
      </div>
    </PopoverContext>
  );
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object")
        (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export interface PopoverTriggerProps {
  /** A single focusable element (e.g. a Button) that opens the popover. */
  children: ReactElement;
}

function compose<Event extends { defaultPrevented: boolean }>(
  childHandler: ((event: Event) => void) | undefined,
  handler: (event: Event) => void,
) {
  return (event: Event) => {
    childHandler?.(event);
    if (!event.defaultPrevented) handler(event);
  };
}

// Observation, not action. `compose` steps aside for a child that handled
// the event itself, which is right for anything that *does* something — but
// a child preventing the pointerdown default (to hold focus, say) has not
// said the gesture didn't happen. Skipping the record there left the panel
// reading whatever the gesture before it had put in.
function observe<Event>(
  childHandler: ((event: Event) => void) | undefined,
  handler: (event: Event) => void,
) {
  return (event: Event) => {
    childHandler?.(event);
    handler(event);
  };
}

export function PopoverTrigger({ children }: PopoverTriggerProps) {
  const context = usePopoverContext("PopoverTrigger");
  // What the last gesture on the trigger was, and whether the panel was
  // already open when it started. A click reports neither.
  const tap = useTapGesture<boolean>();

  if (!isValidElement<React.HTMLProps<HTMLElement> & { "data-state"?: string }>(children))
    return children;

  const childProps = children.props;

  return cloneElement(children, {
    // The hover trigger keeps its hover path and *adds* a tap one, rather than
    // swapping mode on a device that reports a touchscreen: a touchscreen laptop
    // has both inputs and the mouse must keep working. A hovering pointer has
    // already opened the panel on its way in, and a keyboard press arrives with
    // no pointerdown behind it, so only a tap toggles here. Which panel state
    // the tap acts on is read from the gesture's start, because a browser that
    // focuses the trigger on contact would otherwise open it mid-gesture and let
    // the click close it again.
    ...(context.triggerMode === "hover"
      ? {
          onFocus: compose(childProps.onFocus, context.openHover),
          onBlur: compose(childProps.onBlur, context.scheduleClose),
          onPointerDown: observe(childProps.onPointerDown, (event) =>
            tap.start(event, context.open),
          ),
          onPointerCancel: observe(childProps.onPointerCancel, tap.drop),
          onKeyDown: observe(childProps.onKeyDown, tap.drop),
          onClick: compose(childProps.onClick, () => {
            const gesture = tap.take();
            if (!gesture || gesture.pointerType === "mouse") return;
            context.setOpen(!gesture.state);
          }),
        }
      : { onClick: compose(childProps.onClick, context.toggle) }),
    ref: mergeRefs(childProps.ref, (node: HTMLElement | null) => {
      context.triggerRef.current = node;
    }),
    // Above the goo layer (z-[-1]) so the neck reads behind it.
    className: cn("relative z-0", childProps.className),
    "aria-haspopup": "dialog",
    "aria-expanded": context.open,
    "aria-controls": context.open ? context.contentId : undefined,
    "data-state": context.open ? "open" : "closed",
  });
}

const ALIGN_ORIGIN: Record<Align, string> = {
  start: "left",
  center: "center",
  end: "right",
};

export interface PopoverContentProps {
  children: ReactNode;
  className?: string;
}

export function PopoverContent({ children, className }: PopoverContentProps) {
  const context = usePopoverContext("PopoverContent");
  const [portalReady, setPortalReady] = useState(false);
  const {
    side,
    align,
    gap,
    panelRadius,
    gooStrength,
    prefersReducedMotion,
    gooId,
    contentId,
    progress,
    triggerRef,
    contentRef,
    open,
    triggerMode,
    openHover,
    scheduleClose,
  } = context;

  const measureRef = contentRef;
  const panelHover = useHoverGesture();
  const blobRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const supportsShapeRef = useRef(false);
  const layout = usePopoverPortalPosition(triggerRef, measureRef, portalReady && open);

  useEffect(() => setPortalReady(true), []);

  const geometry = useMemo(
    () =>
      buildGeometry({
        triggerWidth: layout?.trigger.width ?? 0,
        triggerHeight: layout?.trigger.height ?? 0,
        contentWidth: layout?.content.width ?? 0,
        contentHeight: layout?.content.height ?? 0,
        side,
        align,
        gap,
        panelRadius,
      }),
    [layout, side, align, gap, panelRadius],
  );

  // Morph the same clip on the goo body and the content, so the whole popover
  // oozes as one and the text reveals with it.
  const render = useCallback((currentGeometry: Geometry | null, progressValue: number) => {
    if (!currentGeometry || currentGeometry.layerWidth === 0) return;
    const clip = clipPathAtProgress(currentGeometry, progressValue, supportsShapeRef.current);
    if (blobRef.current) blobRef.current.style.clipPath = clip;
    if (clipRef.current) clipRef.current.style.clipPath = clip;
  }, []);

  useLayoutEffect(() => {
    supportsShapeRef.current =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("clip-path", "shape(from 0px 0px, line to 1px 1px, close)");
    geometryRef.current = geometry;
    render(geometry, progress.get());
  }, [geometry, progress, render]);

  useMotionValueEvent(progress, "change", (progressValue) =>
    render(geometryRef.current, progressValue),
  );

  const hoverHandlers =
    triggerMode === "hover" ? makeHoverHandlers(panelHover, openHover, scheduleClose) : {};

  // Match the server and first client render, then attach the portal after
  // hydration. This preserves SSR without regenerating the page on the client.
  if (!portalReady) return null;

  return createPortal(
    <div
      data-popover-portal=""
      className="pointer-events-none fixed top-0 left-0 isolate z-9999 size-0"
      style={{
        visibility: layout ? "visible" : "hidden",
        transform: `translate3d(${layout?.trigger.left ?? 0}px, ${layout?.trigger.top ?? 0}px, 0)`,
      }}
    >
      {/* Goo filter: blur, sharpen the alpha back into solid shapes, then lay
          the crisp original on top so blobs merge with liquid edges. */}
      <svg aria-hidden width="0" height="0" className="absolute">
        <title>Popover visual effects</title>
        <defs>
          <filter id={gooId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={gooStrength} result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      {/* Goo body: static trigger pill + morphing blob. */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-[-1]"
        style={{
          left: geometry.left,
          top: geometry.top,
          width: geometry.layerWidth,
          height: geometry.layerHeight,
          filter: prefersReducedMotion || gooStrength === 0 ? undefined : `url(#${gooId})`,
          clipPath: triggerCutoutPath(geometry),
        }}
      >
        <div
          className="absolute bg-popover"
          style={{
            left: geometry.trigger.x,
            top: geometry.trigger.y,
            width: geometry.trigger.width,
            height: geometry.trigger.height,
            borderRadius: geometry.trigger.radius,
          }}
        />
        <div
          ref={blobRef}
          className="absolute inset-0 bg-popover"
          style={{
            clipPath: clipPathAtProgress(geometry, progress.get(), false),
          }}
        />
      </div>

      {/* Content is clipped by the same morph. The portal wrapper stays
          pointer-transparent; only the fully open panel accepts interaction. */}
      <div
        className="pointer-events-none absolute z-10"
        style={{
          left: geometry.left,
          top: geometry.top,
          width: geometry.layerWidth,
          height: geometry.layerHeight,
        }}
      >
        <div
          ref={clipRef}
          inert={!open}
          className="absolute inset-0"
          style={{
            clipPath: clipPathAtProgress(geometry, progress.get(), false),
            pointerEvents: open ? "auto" : "none",
          }}
        >
          <div
            ref={measureRef}
            id={contentId}
            role="dialog"
            {...hoverHandlers}
            style={{
              position: "absolute",
              left: geometry.panel.x,
              top: geometry.panel.y,
              transformOrigin: `${ALIGN_ORIGIN[align]} ${side === "bottom" ? "top" : "bottom"}`,
            }}
            className={cn(
              "w-max max-w-[min(92vw,20rem)] p-4 text-popover-foreground outline-none",
              className,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

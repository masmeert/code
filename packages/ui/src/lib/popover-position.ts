import { type MutableRefObject, useCallback, useLayoutEffect, useState } from "react";

export type PortalLayout = {
  trigger: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  content: {
    width: number;
    height: number;
  };
};

function isSameLayout(a: PortalLayout | null, b: PortalLayout) {
  return (
    a?.trigger.left === b.trigger.left &&
    a.trigger.top === b.trigger.top &&
    a.trigger.width === b.trigger.width &&
    a.trigger.height === b.trigger.height &&
    a.content.width === b.content.width &&
    a.content.height === b.content.height
  );
}

/** Measures a trigger and portalled panel in viewport coordinates. */
export function usePopoverPortalPosition<
  TriggerElement extends HTMLElement,
  ContentElement extends HTMLElement,
>(
  triggerRef: MutableRefObject<TriggerElement | null>,
  contentRef: MutableRefObject<ContentElement | null>,
  active: boolean,
) {
  const [layout, setLayout] = useState<PortalLayout | null>(null);

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;

    const rect = trigger.getBoundingClientRect();
    const next: PortalLayout = {
      trigger: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      content: {
        width: content.offsetWidth,
        height: content.offsetHeight,
      },
    };
    setLayout((current) => (isSameLayout(current, next) ? current : next));
  }, [contentRef, triggerRef]);

  useLayoutEffect(() => {
    update();
    if (!active) return;

    const trigger = triggerRef.current;
    const content = contentRef.current;
    const observer = new ResizeObserver(update);
    if (trigger) observer.observe(trigger);
    if (content) observer.observe(content);

    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    }

    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [active, contentRef, triggerRef, update]);

  return layout;
}

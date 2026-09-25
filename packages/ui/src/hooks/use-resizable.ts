import { useCallback, useRef, useState } from "react";

const read = (key: string, fallback: number) => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

/** Width last dragged to (px), for placeholders rendered before the resizable itself. */
export const readWidth = read;

/**
 * A width the user drags with a handle, remembered per `key`.
 * `side` is where the handle sits on the element: "start" grows the element when dragged left.
 * `clamp` bounds the width at drag time (e.g. against the parent's current size).
 */
export const useResizable = (opts: {
  key: string;
  initial: number;
  side: "start" | "end";
  clamp: (width: number) => number;
}) => {
  const [width, setWidth] = useState(() => read(opts.key, opts.initial));
  const [dragging, setDragging] = useState(false);
  const latest = useRef(opts);
  latest.current = opts;

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = width;
      let next = startWidth;
      setDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const move = (e: PointerEvent) => {
        const delta = e.clientX - startX;
        next = latest.current.clamp(Math.round(startWidth + (latest.current.side === "start" ? -delta : delta)));
        setWidth(next);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        setDragging(false);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        try {
          localStorage.setItem(latest.current.key, String(next));
        } catch {}
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [width],
  );

  /** Double-click the handle to go back to the default width. */
  const onDoubleClick = useCallback(() => {
    const next = latest.current.clamp(latest.current.initial);
    setWidth(next);
    try {
      localStorage.removeItem(latest.current.key);
    } catch {}
  }, []);

  /** Arrow keys nudge the width, so the handle works without a pointer. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowLeft" ? -1 : 1);
      const next = latest.current.clamp(width + (latest.current.side === "start" ? -step : step));
      setWidth(next);
      try {
        localStorage.setItem(latest.current.key, String(next));
      } catch {}
    },
    [width],
  );

  return { width, dragging, handleProps: { onPointerDown, onDoubleClick, onKeyDown } };
};

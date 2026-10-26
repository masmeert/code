import type { KeyboardEvent } from "react";
import { focusComposer } from "@/widgets/composer";

/**
 * Esc anywhere in a side panel closes it and hands focus back to the composer. Fields and
 * terminals keep Esc for themselves, and so do menus portaled out of the panel.
 */
export function closeOnEscape(close: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;

    const { target } = event;

    if (
      !(target instanceof Element) ||
      !event.currentTarget.contains(target) ||
      target.closest("input, textarea, select, [contenteditable]")
    )
      return;

    event.preventDefault();
    close();
    focusComposer();
  };
}

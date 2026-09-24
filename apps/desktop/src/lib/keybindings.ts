import { useEffect, useRef } from "react";

/**
 * Every app shortcut in one place, as `mod+shift+key` strings (`mod` is ⌘ on macOS,
 * Ctrl elsewhere). Components refer to them by id, so a later settings page can
 * rebind them without touching the components.
 */
export const KEYBINDINGS = {
  "palette.open": "mod+k",
  "thread.new": "mod+n",
  "settings.open": "mod+,",
  "composer.stash": "mod+s",
  "picker.model": "mod+shift+m",
  "picker.effort": "mod+shift+e",
  "picker.permission": "mod+shift+a",
  "picker.workspace": "mod+shift+x",
  "picker.branch": "mod+shift+g",
} as const;

export type KeybindingId = keyof typeof KEYBINDINGS;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether a key event is the shortcut `binding`. */
export const matches = (event: KeyboardEvent | React.KeyboardEvent, binding: string) => {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1)!;
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (mod !== modPressed || shift !== event.shiftKey || alt !== event.altKey) return false;
  // With shift held, `key` is the shifted character; `code` still names the key.
  const pressed = event.key.toLowerCase();
  return pressed === key || event.code.toLowerCase() === `key${key}`;
};

/** How a shortcut reads in the UI, e.g. ⌘⇧M. */
export const describe = (id: KeybindingId) =>
  KEYBINDINGS[id]
    .split("+")
    .map((part) => (part === "mod" ? (isMac ? "⌘" : "Ctrl+") : part === "shift" ? "⇧" : part === "alt" ? "⌥" : part.toUpperCase()))
    .join("");

/** Runs `onPress` on the shortcut while mounted. */
export const useKeybinding = (id: KeybindingId | undefined, onPress: (event: KeyboardEvent) => void) => {
  const handler = useRef(onPress);
  handler.current = onPress;
  useEffect(() => {
    if (!id) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matches(event, KEYBINDINGS[id])) return;
      event.preventDefault();
      handler.current(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);
};

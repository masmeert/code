import { formatBinding, matches } from "@masmeert/ui/lib/keys";
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
  "composer.steerQueued": "mod+shift+enter",
  "picker.model": "mod+shift+m",
  "picker.effort": "mod+shift+e",
  "picker.permission": "mod+shift+a",
  "picker.workspace": "mod+shift+x",
  "picker.machine": "mod+shift+h",
  "picker.branch": "mod+shift+g",
  "terminal.toggle": "mod+j",
  "browser.toggle": "mod+shift+b",
  "simulator.toggle": "mod+shift+i",
  "usage.toggle": "mod+shift+u",
  "keepAwake.toggle": "mod+shift+k",
  "services.open": "mod+shift+p",
  "diff.saveComment": "mod+enter",
  "scripts.save": "mod+enter",
  "thread.find": "mod+f",
  "thread.findNext": "mod+g",
  "diff.toggle": "mod+shift+d",
  "git.commit": "mod+shift+c",
  "window.new": "mod+shift+n",
  // Handled by the kit's sidebar; listed so menus can show it.
  "sidebar.toggle": "mod+b",
} as const;

export type KeybindingId = keyof typeof KEYBINDINGS;

/** How a shortcut reads in the UI, e.g. ⌘⇧M. */
export function formatKeybinding(id: KeybindingId) {
  return formatBinding(KEYBINDINGS[id]);
}

/** Runs `onPress` on the shortcut while mounted. */
export function useKeybinding(
  id: KeybindingId | undefined,
  onPress: (event: KeyboardEvent) => void,
) {
  const handler = useRef(onPress);
  handler.current = onPress;
  useEffect(() => {
    if (!id) return;

    // An arrow, so `id` stays narrowed to defined inside it.
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matches(event, KEYBINDINGS[id])) return;
      event.preventDefault();
      handler.current(event);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, [id]);
}

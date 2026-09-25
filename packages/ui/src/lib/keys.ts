/**
 * Key bindings as `mod+shift+key` strings: `mod` is ⌘ on macOS and Ctrl elsewhere,
 * `alt` is ⌥ / Alt.
 */

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

/** How a binding reads in the UI, e.g. ⌘⇧M. */
export const formatBinding = (binding: string) =>
  binding
    .split("+")
    .map((part) => (part === "mod" ? (isMac ? "⌘" : "Ctrl+") : part === "shift" ? "⇧" : part === "alt" ? "⌥" : part.toUpperCase()))
    .join("");

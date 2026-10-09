import { useEffect } from "react";

/** Fires on ⌘<key>. */
export function useShortcut(key: string, onPress: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey && event.key === key) {
        event.preventDefault();
        onPress();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, onPress]);
}

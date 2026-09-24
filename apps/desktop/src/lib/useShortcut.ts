import { useEffect } from "react";

/** Fires on ⌘<key>. */
export const useShortcut = (key: string, onPress: () => void) =>
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === key) {
        e.preventDefault();
        onPress();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, onPress]);

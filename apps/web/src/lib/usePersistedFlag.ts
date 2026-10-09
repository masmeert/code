import { useState } from "react";

/** A boolean UI preference (a folded section, say) remembered per window origin. */
export function usePersistedFlag(key: string, fallback: boolean) {
  const [isOn, setIsOn] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "1";
    } catch {
      return fallback;
    }
  });

  function setFlag(next: boolean) {
    setIsOn(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {}
  }

  return [isOn, setFlag] as const;
}

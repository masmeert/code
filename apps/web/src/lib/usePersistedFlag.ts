import { useState } from "react";

/** A boolean UI preference (a folded section, say) remembered per window origin. */
export const usePersistedFlag = (key: string, fallback: boolean) => {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "1";
    } catch {
      return fallback;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {}
  };
  return [value, set] as const;
};
